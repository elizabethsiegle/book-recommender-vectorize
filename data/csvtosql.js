const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

// Path to the uploaded CSV file
const csvFilePath = path.join(__dirname, 'goodreads_library_export.csv');
const sqlFilePath = path.join(__dirname, 'goodreads_data.sql');

// Initialize list to store SQL insert statements
let sqlStatements = [];

// Read the CSV file
fs.createReadStream(csvFilePath)
  .pipe(csv())
  .on('data', (row) => {
    // Extract quote and author, assuming they are in the first two columns
    const title = row['Title'].replace(/'/g, "''");
    const author = row['Author'].replace(/'/g, "''");
    const avg_rating = row['Average Rating'].replace(/'/g, "''");
    const bookshelves = row['Bookshelves'].replace(/'/g, "''");

    // Get the current row number
    const id = sqlStatements.length + 1;

    // Create the SQL insert statement
    sqlStatements.push(`INSERT INTO btable (id, title, author, avg_rating, bookshelves) VALUES ('${id}', '${title}', '${author}', '${avg_rating}', '${bookshelves}');`);
  })
  .on('end', () => {
    // Combine the CREATE TABLE statement with the insert statements
    const sqlScript = `
CREATE TABLE IF NOT EXISTS btable (
  id VARCHAR(50),
  title VARCHAR(50),
  author VARCHAR(50),
  avg_rating VARCHAR(50),
  bookshelves VARCHAR(50)
);\n` + sqlStatements.join('\n');

    // Write the SQL script to a file
    fs.writeFile(sqlFilePath, sqlScript, (err) => {
      if (err) throw err;
      console.log('SQL script written successfully to goodreads_data.sql');
    });
  });
