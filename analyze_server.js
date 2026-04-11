const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  conn.exec('cat /etc/nginx/sites-available/zabor', (err, stream) => {
    if (err) throw err;
    let data = '';
    stream.on('close', (code, signal) => {
      console.log('Zabor Config:\n' + data);
      conn.end();
    }).on('data', (d) => {
      data += d;
    }).stderr.on('data', (d) => {
      data += d;
    });
  });
}).connect({
  host: '150.241.64.108',
  port: 22,
  username: 'root',
  password: 'mvtxbJo45sc8'
});
