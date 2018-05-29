---
layout: post
order: 5
---

WebRTC is not new anymore and a lot of web applications and companies already use it. However, I think WebRTC still has much more to offer. WebRTC is primarily intended for peer-to-peer video connections, but here I will discuss data channels: one peer-to-peer application and one peer-to-server application.

## Peer to peer data transfer

Peer to peer data transfer over WebRTC is already being used by services such as [File Pizza](https://file.pizza/) and [ShareDrop](https://www.sharedrop.io/) to let you transfer files manually. However, the same tech can be used to set up a more permanent p2p network _with customer-proof NAT traversal_. And that without you having to maintain any code. This makes it very easy to build and deploy peer-to-peer software, much easier than other p2p solutions such as BitTorrent.

One application that I would personally like to see (or develop) is a NAS that automatically sends encrypted backups (or photos, etc) to friends.

## Unordered data for games

WebRTC has an interesting monopoly: it's the only (native) way to send data to and from the browser unordered. This is thanks to the use of SCTP, which supports both ordered and unordered data streams. Sending unordered data is unimportant for most websites, but critical for low-latency applications, especially over flaky connections. Multiplayer action games are the prime example.

WebRTC is primarily intended for peer-to-peer connections, but nothing is stopping a server from being one of the peers. In fact, it makes things easier, because the server is always reachable, which means STUN and TURN are not really necessary. STUN still has to be configured, but I think TURN can be avoided completely (and otherwise it's just the administrative matter of setting up a TURN server next to you application server). The only downside is that there's quite a bit of fluff to WebRTC that is not necessary for server-to-peer connections and it may get in the way.

A lot of tutorials and example material is somewhat out of date and doesn't include data channels or unordered data streams. In the end, I got a simple solution based on [node-webrtc](https://github.com/js-platform/node-webrtc) (nodejs) for the server to work. Here's the relevant code samples to get UDP-like data transfer from the browser to the server running; 200 connections should be easily achieved. More is possible, but CPU usage became quite high. For 500+ connections you might need to switch to an implementation that's optimized for large numbers of data channels.

Note that you should set up your own STUN server for production use, the google server is only for development. STUN is very simple so this shouldn't be an issue.

The complete demo can be pulled from [the repo](https://github.com/RemcoTukker/WebRTC-SCTP-Demo).

### Client side

```javascript
function logError(err) { console.log(err.toString(), err); }

var pcConfig = {'iceServers': [{'urls': 'stun:stun.l.google.com:19302'}]};
var socket = io.connect();
var pc;

name = prompt('Enter your name:');
```
Just an error handler that we will use later on, the WebRTC config that just includes a STUN server, and using socket.io for the signalling between the browser and the server while the WebRTC connection is not yet up. `pc` will hold the peer connection. Finally we prompt the user for their name, but we won't use it in this example; it's just convenient to start everything when you press OK.

```javascript
pc = new RTCPeerConnection(pcConfig);

socket.on('message', function(message) {
  if (message.type === 'answer') {
    pc.setRemoteDescription(new RTCSessionDescription(message), function(){}, logError);
  } else if (message.type === 'candidate') {
    pc.addIceCandidate(message.candidate);
  }
});

socket.emit('ready');

pc.onicecandidate = function(candidate) {
  if (!candidate.candidate) return;
  socket.emit('message', {
    type: 'candidate',
    label: candidate.sdpMLineIndex,
    id: candidate.sdpMid,
    candidate: candidate.candidate
  });
};
```
We create a peer connection. The peer connection needs 2 things from the server to set up the WebRTC connection: a session description and ice candidates. We get this info through socket.io messages. Then we send a socket.io message to the server, so that it knows to prepare a peerconnection for us to connect to. Finally we set onicecandidate, so that when we get information on how to connect to this browser (through STUN for example), we send it to the server using socket.io. Because the server prepared a peerconnection for us, it will be able to set this candidate info on its peerconnection immediately.

```javascript
dc = pc.createDataChannel('test1', { ordered: false, maxRetransmits: 0 });
dc.onopen = function() {
  dc.onmessage = function(event) {
    var data = event.data;
    console.log('webrtc datachannel received "' + data + '" at ' + Date.now());
  };
  setTimeout(function() { dc.send('x: 1234, y: 99.1, more: sefgv'); }, 33);
};
```
Now we get to our data channel, ensuring that it is indeed unordered. `maxRetransmits` is 0, because if a message didn't arrive, we don't care. All info of which we are not sure yet that it arrived is included in each message that we send, so that information arrives as quickly as possible even when message go missing. When the data channel is open, we may receive messages, which in this case are logged to the console. It's also possible to send messages, in a typical game you would for example send a message each 33 or 60 ms with user input data.

```javascript
pc.createOffer().then(
  function (sessionDescription) {
    pc.setLocalDescription(sessionDescription);
    socket.emit('message', sessionDescription);
  },
  logError
);
```
The only thing left to do is to create an offer to connect and send it to the server. This kicks off the actual negotiation process which will result in the connection. Here the local description is set; the server should reply with the 'answer' message that is handled by `socket.on('message', ..` above which sets the remote description. When there are also ICE candidates available, the connection will be established!

### Server side

```javascript
function logError(err) { console.log(err.toString(), err); }

var static1 = require('node-static');
var http = require('http');
var file = new(static1.Server)();
var app = http.createServer(function (req, res) { file.serve(req, res); }).listen(8000);

var io = require('socket.io').listen(app);
var webrtc = require('wrtc');
var RTCPeerConnection = webrtc.RTCPeerConnection;
var RTCSessionDescription = webrtc.RTCSessionDescription;

var pcConfig = {'iceServers': [{'urls': 'stun:stun.l.google.com:19302'}]}
var aSocket; // TODO manage multiple sockets to allow for multiple players..
var pc;
```
Setting up a server that serves the html and js; require socket.io for signalling, and of course wrtc (node-webrtc). The WebRTC config is the same as for the client.

```javascript
io.sockets.on('connection', function (socket){
  aSocket = socket;
  socket.on('ready', createPeerConnection);
  socket.on('message', function (message){
    if (message.type === 'offer') {
      console.log('Got offer. Sending answer to peer.');
      pc.setRemoteDescription(new RTCSessionDescription(message), function(){}, logError);
      pc.createAnswer().then(
        function (sessionDescription) {
          pc.setLocalDescription(sessionDescription);
          aSocket.emit('message', sessionDescription);
        },
        logError
      );
    } else if (message.type === 'candidate') {
      pc.addIceCandidate(message.candidate);
    }
  });
});
```
Here we define what to do when the client sends us a signalling message over socket.io: the 'ready' message should be first and means we should set up a peer connection. After that we can receive an offer with the session description of the browser. We set it as the remote description and reply to this message with our own session description. ICE candidates that we receive from the browser are added to the peer connection.

```javascript
function createPeerConnection() {
  pc = new RTCPeerConnection(pcConfig);
  pc.onicecandidate = function(candidate) {
    if (!candidate.candidate) return;
    aSocket.emit('message', {
      type: 'candidate',
      label: candidate.sdpMLineIndex,
      id: candidate.sdpMid,
      candidate: candidate.candidate
    });
  };
  pc.ondatachannel = function(event) {
    var dc = event.channel;
    dc.onopen = function() {
      dc.onmessage = function(event) {
        var data = event.data;
        console.log('webrtc datachannel received "' + data + '" at ' + Date.now());
      };
    };
    setTimeout(function() { dc.send('x:42, y:-2.99, more: asdfghj'); }, 33);
  };
}
```
Setting up the peer connection. ICE candidates work exactly the same as on the client. As we don't initiate the datachannel however, we have to wait for the ondatachannel event; once we have the data channel it is the same as on the client again.

## Links

 * [WebRTC home page](https://webrtc.org/)
 * [WebRTC wikipedia](https://en.wikipedia.org/wiki/WebRTC)
 * [SCTP wikipedia](https://en.wikipedia.org/wiki/Stream_Control_Transmission_Protocol)
 * [node-webrtc](https://github.com/js-platform/node-webrtc)
 * [Emergence Vector](https://www.emergencevector.com/blog) A game that is build using WebRTC. I think the server is not based on NodeJS though.
 * [WebUDP](https://github.com/seemk/WebUdp) C++ implementation of a WebRTC server for unordered datachannels; maybe this can be used to scale up further.
 * [WebRTC for client-server web games](http://blog.brkho.com/2017/03/15/dive-into-client-server-web-games-webrtc/) In depth article about unordered data channels for games including instructions on C++ for buildign the server.

## Links relating to game networking

 * [Networking for Physics Programmers](http://gdcvault.com/play/1022195/Physics-for-Game-Programmers-Networking) Excellent intro/overview of simulating game physics in a networked game by Glenn Fiedler.
 * [Gaffer on Games](https://gafferongames.com/) Many moreo relevant articles by Glenn Fiedler. Note that he has an article about UDP in the browser, stating that WebRTC is too complicated/heavy weight.
 * [Gabriel Gambetta](http://www.gabrielgambetta.com/client-server-game-architecture.html) Another introduction to (fast-paced) multiplayer games, focussing on lag compensation.

