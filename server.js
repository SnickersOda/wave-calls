const express = require('express');
const { ExpressPeerServer } = require('peer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Отдаём HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'calls.html'));
});

const server = require('http').createServer(app);

// Свой PeerJS сервер на том же домене
const peerServer = ExpressPeerServer(server, {
  debug: true,
  path: '/'
});

app.use('/peerjs', peerServer);

server.listen(PORT, () => console.log(`Running on port ${PORT}`));
