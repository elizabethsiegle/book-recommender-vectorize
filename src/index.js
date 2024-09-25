import { Hono } from "hono";
const app = new Hono();

function padVector(vector, targetLength) {
    if (vector.length >= targetLength) {
        return vector;
    }
    return [...vector, ...new Array(targetLength - vector.length).fill(0)];
}

app.post("/books", async (c) => {
	const ai = c.env.AI;

	const { text } = await c.req.json();
	console.log(`text: ${text}`);
	if (!text) {
		return c.text("Missing text", 400);
	}

	const { results } = await c.env.DB.prepare(
		"INSERT INTO btable (text) VALUES (?) RETURNING *"
	)
    .bind(text)
    .run();

	const record = results.length ? results[0] : null;

	if (!record) {
    	return c.text("Failed to create book", 500);
  	}

	const { data } = await ai.run("@cf/baai/bge-large-en-v1.5", { text: [text] });
	const values = data[0];

	if (!values) {
    	return c.text("Failed to generate vector embedding", 500);
  	}
	console.log(`record: ${record}`);
	const { id } = record;
	console.log(`id ${id}`);
	const inserted = await c.env.VECTORIZE_INDEX.upsert([
		{
		id: id.toString(),
		values,
		},
	]);

  	return c.json({ id, text, inserted });
  });

  app.get('/', async (c) => {
	const query = c.req.query('text') || "Recommend me a book"
	console.log(`query: ${query}`);
  
	const embeddings = await c.env.AI.run('@cf/baai/bge-base-en-v1.5', { text: query });
	console.log(`embeddings: ${JSON.stringify(embeddings)}`);
	
	const queryVector = embeddings.data[0];
	// Pad the vector to 1024 dimensions
	const paddedQueryVector = padVector(queryVector, 1024);

	console.log(`vectors: ${JSON.stringify(paddedQueryVector)}`);
	const matches = await c.env.VECTORIZE_INDEX.query(paddedQueryVector, {
		topK: 5,
  		returnValues: true,
  		returnMetadata: true, // 'all'
	});
	console.log(`matches: ${JSON.stringify(matches)}`);

  
	// Extract book information from matches
	const books = matches.matches.map(match => ({
		id: match.id,
		title: match.metadata.title || 'Unknown Title',
		author: match.metadata.author || 'Unknown Author',
		avg_rating: match.metadata.avg_rating || 'N/A',
		similarity: match.score
	  }));
	
	  // Generate a response using AI
	  const contextMessage = books.length
		? `Similar books based on the query:\n${books.map(book => `- "${book.title}")`).join("\n")}`
		: "No similar books found.";
	
	  const systemPrompt = `Return 2 sentences containing book recommendations from the similar books provided if they have a title. Do not return them if they don't have a title. Explain why they might be good choices and return nothing else.`;
	
	  const { response: answer } = await c.env.AI.run(
		'@cf/meta/llama-2-7b-chat-int8',
		{
		  messages: [
			{ role: 'system', content: contextMessage },
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: query }
		  ]
		}
	  );
	
	  return c.json({
		query: query,
		similar_books: books,
		recommendation: answer
	  });
  });

  app.get('/populate', async (c) => {
	let query = `SELECT id, title, author, avg_rating, bookshelves
		  FROM btable
		  WHERE bookshelves LIKE '%read%'
		  	AND avg_rating > 3.7
		  ORDER BY avg_rating DESC
		  LIMIT 200;`;
		  
	let results = await c.env.DB.prepare(query).all();
	console.log(`results in populate ${JSON.stringify(results)}`);

	const BATCH_SIZE = 10;  // You can adjust this number
	const DELAY_MS = 500;  // Delay in milliseconds between batches
	let batch = [];

	async function processBatch(batch) {
		try {
			await c.env.VECTORIZE_INDEX.upsert(batch);
			console.log(`Batch inserted with ${batch.length} books`);
		} catch (error) {
			console.error('Error during upsert:', error);
		}
	}

	async function delay(ms) {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	for (const row of results.results) {
		console.log(`row ${JSON.stringify(row)}`);
		const { id, title, author, avg_rating, bookshelves } = row;

		// Get embeddings for the title
		const embeddings = await c.env.AI.run("@cf/baai/bge-large-en-v1.5", { text: [title] });
		console.log(`embeddings.data[0] ${embeddings.data[0]}`);

		// Add the upsert task to the batch
		batch.push({
			id: id.toString(),
			metadata: { author: author, avg_rating: avg_rating, bookshelves: bookshelves },
			values: embeddings.data[0]
		});

		// If the batch size is reached, upsert the batch and introduce a delay
		if (batch.length >= BATCH_SIZE) {
			await processBatch(batch);
			batch = [];  // Clear the batch for the next set of upserts
			await delay(DELAY_MS);  // Introduce a delay between batches
		}
	}

	// Insert any remaining books in the final batch
	if (batch.length > 0) {
		await processBatch(batch);
	}

	console.log(`Populate process completed.`);
});
  
  // New endpoint to start or continue the population process
  app.get('/start-populate', async (c) => {
	const cursor = c.req.query('cursor') || '0';
	const url = new URL(c.req.url);
	url.pathname = '/populate';
	url.searchParams.set('cursor', cursor);
	
	const response = await fetch(url.toString(), {
	  headers: c.req.headers
	});
	
	const result = await response.json();
	
	if (result.nextCursor) {
	  // Schedule the next batch
	  await c.env.QUEUE.send({
		url: `/start-populate?cursor=${result.nextCursor}`
	  });
	  return c.json({ message: "Batch processed, next batch scheduled", ...result });
	} else {
	  return c.json({ message: "Population complete", ...result });
	}
  });
  
  
  app.onError((err, c) => {
	return c.text(err);
  });

export default app;

