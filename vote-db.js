const sqlite = require('sqlite')
const sqlite3 = require('sqlite3')

module.exports = sqlite.open({
  filename: __dirname + '/SQLite3/vote.db',
  driver: sqlite3.Database,
})
