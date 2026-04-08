const { Client } = require('ssh2');

const command = process.argv.slice(2).join(' ');

const conn = new Client();
conn.on('ready', () => {
  conn.exec(command, (err, stream) => {
    if (err) throw err;
    stream.on('close', (code, signal) => {
      conn.end();
    }).on('data', (data) => {
      process.stdout.write(data);
    }).stderr.on('data', (data) => {
      process.stderr.write(data);
    });
  });
}).connect({
  host: '150.241.64.108',
  port: 22,
  username: 'root',
  password: 'mvtxbJo45sc8'
});
