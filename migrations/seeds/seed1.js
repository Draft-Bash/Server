exports.seed = async function (knex) {
  const seedNbaTeams = require('../../seeds/seedNbaTeams');
  const seedNbaPlayers = require('../../seeds/seedNbaPlayers');
  const seedPointsRanking = require('../../seeds/seedPointsRankingsTable');
  const seedPreviousSeasonStats = require('../../seeds/seedPreviousSeasonStats');

  try {
      // Start seeding sequentially
      await seedNbaTeams();
      console.log('NBA teams seeded successfully.');

      await seedNbaPlayers();
      console.log('NBA players seeded successfully.');

      await seedPointsRanking();
      console.log('Points ranking seeded successfully.');

      await seedPreviousSeasonStats();
      console.log('Previous season stats seeded successfully.');

      console.log('All seed files have been executed successfully.');

  } catch (error) {
    console.error('Error during seeding:', error);
    throw error; // Throw the error to stop the seed process on failure
  }
};