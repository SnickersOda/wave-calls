const express = require('express');
const { ExpressPeerServer } = require('peer');
const path = require('path');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'calls.html'));
});

const server = http.createServer(app);

const peerServer = ExpressPeerServer(server, { debug: true });
app.use('/peerjs', peerServer);

server.listen(PORT, () => console.log('Running on port ' + PORT));
