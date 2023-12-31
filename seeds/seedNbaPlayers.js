const fs = require('fs');
const csvParser = require('csv-parser');
const pg = require('pg');
const dotenv = require('dotenv');
dotenv.config();

// Database connection configuration
const playerDbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  ssl: JSON.parse(process.env.SSL)
};

// CSV file path
const playerCsvFilePath = 'nbaData/nba_players.csv';

// Export the seed function directly
module.exports = function () {
  return new Promise(async (resolve, reject) => {
    const client = new pg.Client(playerDbConfig);

    try {
      await client.connect();
      console.log('Connected to the database.');

      const insertPromises = [];

      fs.createReadStream(playerCsvFilePath)
        .pipe(csvParser())
        .on('data', async (row) => {
          try {
            // Insert or update each row into the database table and store the promise
            const insertPromise = client.query(
              `INSERT INTO nba_player (player_id, player_age, first_name, last_name, is_pointguard, is_shootingguard, 
                is_smallforward, is_powerforward, is_center, team_id) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) 
                ON CONFLICT (player_id) 
                DO UPDATE SET player_age = EXCLUDED.player_age, first_name = EXCLUDED.first_name, 
                last_name = EXCLUDED.last_name, is_pointguard = EXCLUDED.is_pointguard, 
                is_shootingguard = EXCLUDED.is_shootingguard, is_smallforward = EXCLUDED.is_smallforward, 
                is_powerforward = EXCLUDED.is_powerforward, is_center = EXCLUDED.is_center, 
                team_id = EXCLUDED.team_id`,
              [
                row.player_id,
                row.player_age,
                row.first_name,
                row.last_name,
                row.is_pointguard,
                row.is_shootingguard,
                row.is_smallforward,
                row.is_powerforward,
                row.is_center,
                row.team_id,
              ]
            );
            insertPromises.push(insertPromise);
            console.log('Inserted or updated row:', row);
          } catch (error) {
            console.error('Error inserting or updating row:', row);
            console.error(error.message);
          }
        })
        .on('end', async () => {
          try {
            // Wait for all the insertion promises to resolve before closing the connection
            await Promise.all(insertPromises);
            resolve(); // Resolve the promise to signal completion
          } catch (error) {
            console.error('Error inserting or updating data:', error.message);
            reject(error); // Reject the promise in case of an error
          } finally {
            // Close the database connection
            client.end();
            console.log('Data insertion or update completed.');
          }
        });
    } catch (error) {
      console.error('Error connecting to the database:', error.message);
      reject(error); // Reject the promise if the connection fails
    }
  });
};