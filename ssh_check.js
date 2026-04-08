const fs = require('fs');
const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  console.log('Client :: ready');
  
  // Checking ufw rules or firewall
  conn.exec('ufw status || iptables -L -n', (err, stream) => {
    if (err) throw err;
    let data = '';
    stream.on('close', (code, signal) => {
      console.log('Stream :: close :: code: ' + code + ', signal: ' + signal);
      console.log('UFW:');
      console.log(data);
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
