var app = require('express')();
var http = require('http').Server(app);
var io = require('socket.io')(http);

app.get('/', function(req, res) {
	res.sendFile(__dirname + '/index.html');
});

var constants = {
	newGameDelay: 4500, // Milliseconds to wait before next game starts
	delay: 25, // Milliseconds between each frame
	pingDelay: 1000, // Milliseconds between each ping
	pingTimeout: 1000, // Milliseconds before a connection times out
	paddleSpeed: 10,
	bulletSpeed: 10,
	stunDelay: 30, // Number of frames of stun animation
	countDownDelay: 60, // Number of frames between each countdown number
	arenaWidth: 320,
	arenaHeight: 480,
	paddleWidth: 64,
	paddleHeight: 5,
	ballWidth: 5,
	ballHeight: 5,
	bulletWidth: 5,
	bulletHeight: 5,
	initialBallSpeed: 5,
	ballSpeedIncrement: 0.2,
	invisibleBallSpeedMultiplier: 1.5 // Used by CPU to "predict" ball destination
}

var users = [];

var gameState = {
	blue: { user: null },
	red: { user: null },
	ball: {},
	invisible_ball: {},
	playSound: []
};

var socketMaster = {};

// New game (hard reset of entire game state)
var newGame = function() {
	gameState.isGameOver = false;
	gameState.countDown = 4 * constants.countDownDelay;
	gameState.timer = '';
	gameState.winner = '';
	gameState.blue.x = constants.arenaWidth - constants.paddleWidth;
	gameState.blue.stunCounter = 0;
	gameState.blue.bullet = null;
	gameState.red.x = 0;
	gameState.red.stunCounter = 0;
	gameState.red.bullet = null;
	// Randomize ball starting position
	gameState.ball.x = constants.paddleWidth + (Math.random() * (constants.arenaWidth - (constants.paddleWidth * 2)));
	if (Math.random() > 0.5) {
		gameState.ball.y = constants.paddleWidth;
		if (Math.random() > 0.5) gameState.ball.direction = 135;
		else gameState.ball.direction = 225;
	} else {
		gameState.ball.y = constants.arenaHeight - constants.paddleWidth;
		if (Math.random() > 0.5) gameState.ball.direction = 45;
		else gameState.ball.direction = 315;
	}
	gameState.ball.speed = constants.initialBallSpeed;
	gameState.invisible_ball.x = gameState.ball.x;
	gameState.invisible_ball.y = gameState.ball.y;
	gameState.invisible_ball.direction = gameState.ball.direction;
	gameState.invisible_ball.speed = constants.initialBallSpeed * constants.invisibleBallSpeedMultiplier;
}
newGame();

var getUserBySocketId = function(socket_id) {
	for (var i = 0; i < users.length; i++) {
		if (users[i].socket_id == socket_id) {
			return users[i];
		}
	}
	return null;
}

var removeUserBySocketId = function(socket_id) {
	for (var i = 0; i < users.length; i++) {
		if (users[i].socket_id == socket_id) {
			users.splice(i, 1);
			return;
		}
	}
}

// Initialize user
var initUser = function(socket) {
	var user = {};
	user['ip_address'] = socket.handshake.address.split(':').slice(-1)[0];
	user['username'] = 'Player ' + user['ip_address'].split('.').slice(-1)[0];

	// Set host user as 'Host'
	if (user['username'] == 'Player 1') user['username'] = 'Host';

	user['socket_id'] = socket.id;
	user['score'] = 0;
	user['ping'] = 0;
	user['input'] = { left: false, right: false, fire: false };
	users.push(user);

	// Add to socket master
	socketMaster[socket.id] = socket;

	// Initialize user input listeners
	socket.on('left', function(val) { user.input.left = val; });
	socket.on('right', function(val) { user.input.right = val; });
	socket.on('fire', function(val) { user.input.fire = val; });

	// Allow host to kick blue or red player (forcefully disconnect)
	socket.on('kick', function(colour) {
		if (user['username'] != 'Host') return; // Only the host can kick
		if (colour != 'blue' || colour != 'red') return; // Can only kick blue or red
		if (gameState[colour].user.username != 'Host' && // Cannot kick host
			gameState[colour].user.username != 'CPU' && // Cannot kick CPU
			socketMaster[gameState[colour].user.socket_id]) {
			socketMaster[gameState[colour].user.socket_id].disconnect();
			console.log('Host kicked ' + gameState[colour].user.username + ' (' + colour + ')');
		}
	});

	console.log(user['username'] + ' connected.');

	return user;
}

// Add CPU opponent
var addCPU = function() {
	var user = {
		ip_address: '0.0.0.0',
		username: 'CPU',
		score: 0,
		ping: 0,
		socket_id: null,
		input: {
			left: false,
			right: false,
			fire: false
		}
	}
	var colours = ['blue', 'red'];
	for (var i = 0; i < colours.length; i++) {
		var colour = colours[i];
		if (!gameState[colour].user) {
			users.push(user);
			gameState[colour].user = user;
			console.log('Added CPU as ' + colour + ' player.');
			break;
		}
	}
}

// Remove CPU opponent
var removeCPU = function() {
	var user = getUserBySocketId(null);
	if (user) {
		if (gameState.blue.user == user) {
			gameState.blue.user = null;
		} else if (gameState.red.user == user) {
			gameState.red.user = null;
		}
		removeUserBySocketId(null);
	}
}

// Disconnect a duplicate connection
var preventDuplicateConnection = function(socket) {
	var ip = socket.handshake.address.split(':').slice(-1)[0];
	for (var i = 0; i < users.length; i++) {
		if (users[i]['ip_address'] == ip) {
			socket.disconnect();
			console.log('Prevented ' + users[i]['username'] + ' from making a duplicate connection.');
			return true;
		}
	}
	return false;
}

// Garbage collect user data
var destroyUser = function(user) {
	if (gameState.blue.user == user) {
		gameState.blue.user = null;
	} else if (gameState.red.user == user) {
		gameState.red.user = null;
	}
	delete socketMaster[user.socket_id];
	removeUserBySocketId(user.socket_id);

	console.log(user['username'] + ' disconnected.');
}

// Add next player in queue to vacant slot, and restart game
var populatePlayerSlots = function() {

	// Remove CPU player if there are at least two human users
	if (users.length > 2) {
		removeCPU();
	}

	// No vacant slots?
	if (gameState.blue.user && gameState.red.user) {
		return;
	}

	// Find a user to place into the vacant slot(s)
	for (var i = 0; i < users.length; i++) {
		var user = users[i];
		if (user == gameState.blue.user || user == gameState.red.user) {
			continue;
		} else {
			var colour = 'red';
			if (!gameState.blue.user) colour = 'blue';

			// Set user to vacant slot
			gameState[colour].user = user;

			// Make sure the new challenger is notified of their colour
			if (socketMaster[user.socket_id]) {
				socketMaster[user.socket_id].emit('colour', colour);
			} else {
				disconnectUser(user);
				return;
			}

			// If no other players, add a CPU player
			if (users.length == 1) addCPU();

			// Restart the game!
			newGame();

			console.log(user['username'] + ' is the ' + colour + ' player.');
			return;
		}
	}
}

// Remove losing player from player slot
var removePlayer = function(losingUser) {
	// Cannot remove CPU players just because they lose...
	if (losingUser.username == 'CPU') {
		// Losing player is no longer an active player
		var colours = ['blue', 'red'];
		for (var i = 0; i < colours.length; i++) {
			var colour = colours[i];
			if (losingUser == gameState[colour].user) {
				console.log('CPU is the ' + colour + ' player.');
				return;
			}
		}
	}

	// Move loser to the bottom of the queue
	removeUserBySocketId(losingUser.socket_id);
	users.push(losingUser);

	// Losing player is no longer an active player
	var colours = ['blue', 'red'];
	for (var i = 0; i < colours.length; i++) {
		var colour = colours[i];
		if (losingUser == gameState[colour].user) {
			gameState[colour].user = null;
		}
	}

	// Turn off redMode
	if (socketMaster[losingUser.socket_id]) {
		socketMaster[losingUser.socket_id].emit('colour', 'blue');
	} else {
		disconnectUser(losingUser);
		return;
	}
}

// Game over
var gameOver = function(losingUser) {
	gameState.isGameOver = true;
	gameState.blue.bullet = null;
	gameState.red.bullet = null;
	setTimeout(function() {
		// Swap out losing player with next player in queue
		removePlayer(losingUser);
		populatePlayerSlots();

		// Start new game!
		newGame();
	}, constants.newGameDelay);
}

var disconnectUser = function(user) {
	// Handle garbage collection
	destroyUser(user);

	// Remove any CPU players
	removeCPU();

	// If no users left, let the game sleep
	if (users.length == 0) {
		newGame();
		console.log('No users connected. Zzz...');
		return;
	} else if (users.length == 1) {
		addCPU();
		newGame();
	}

	// Re-populate player slots if required
	populatePlayerSlots();
}

// Calculate ping
var getPing = function(socket, user) {
	var pingStart = Date.now();
	var pingTimeoutId = 0;

	// Receive a ping response
	socket.on('ping response', function() {
		user.ping = Date.now() - pingStart;
		setTimeout(sendPing, constants.pingDelay);
		clearTimeout(pingTimeoutId);
	});

	// Disconnect user if he times out
	var pingTimedOut = function() {
		disconnectUser(user);
	}

	// Send a ping
	var sendPing = function() {
		pingStart = Date.now();
		socket.emit('ping', true);
		pingTimeoutId = setTimeout(pingTimedOut, constants.pingTimeout);
	}

	sendPing();
}

// Handle user connections
io.on('connection', function(socket) {
	// Prevent multiple connections from the same ip address
	if (preventDuplicateConnection(socket)) return;

	// Initialize user
	var user = initUser(socket);

	// Calculate ping
	getPing(socket, user);

	// Re-populate player slots if required
	populatePlayerSlots();
});

/*
BALL DIRECTION (degrees)
degrees = range(0-359);
             0
             |
         315 | 45
            \|/
270 ---------+--------- 90
            /|\
         225 | 135
             |
            180
*/

// Calculate degrees to radians
var degreesToRadians = function(degrees) {
	return ((Math.PI * 2) / 360) * degrees;
}

// Calculate angle after wall bounce
var angleAfterWallBounce = function(degrees) {
	return 360 - degrees;
}

// Calculate angle after paddle return
var angleAfterPaddleReturn = function(degrees) {
	// Blue paddle
	if (degrees > 90 && degrees < 270) {
		var impactPosition = ((gameState.ball.x + (constants.ballWidth / 2)) - gameState.blue.x) / constants.paddleWidth;
		var minAngle = 300;
		var angleRange = 115;
		var newAngle = (minAngle + (impactPosition * angleRange)) % 360;
		// Vertical angles are not much fun, so let's change it up.
		if (newAngle < 20) {
			newAngle = 20 + (Math.random() * 20);
		} else if (newAngle > 340) {
			newAngle = 340 - (Math.random() * 20);
		}
		return newAngle % 360;
	// Red paddle
	} else {
		var impactPosition = ((gameState.ball.x + (constants.ballWidth / 2)) - gameState.red.x) / constants.paddleWidth;
		var minAngle = 240;
		var angleRange = 115;
		var newAngle = minAngle - (impactPosition * angleRange);
		// Vertical angles are not much fun, so let's change it up.
		if (newAngle < 200 && newAngle >= 180) {
			newAngle = 200 + (Math.random() * 20);
		} else if (newAngle > 160 && newAngle <= 180) {
			newAngle = 160 - (Math.random() * 20);
		}
		return newAngle;
	}
}

// Calculate ball collisions (change directions)
var checkBallCollisions = function() {
	// Wall collisions
	if (gameState.ball.x >= constants.arenaWidth - constants.ballWidth) {
		gameState.playSound.push('pong_wall');
		gameState.ball.x = constants.arenaWidth - constants.ballWidth;
		gameState.ball.direction = angleAfterWallBounce(gameState.ball.direction);
	} else if (gameState.ball.x <= 0) {
		gameState.playSound.push('pong_wall');
		gameState.ball.x = 0;
		gameState.ball.direction = angleAfterWallBounce(gameState.ball.direction);
	}

	// Paddle collisions
	var colours = ['blue', 'red'];
	for (var i = 0; i < colours.length; i++) {
		var colour = colours[i];
		var oppColour = 'blue';
		if (colour == 'blue') oppColour = 'red';
		if ((colour == 'blue' && gameState.ball.y >= constants.arenaHeight - constants.ballHeight) ||
			(colour == 'red' && gameState.ball.y <= constants.ballHeight)) {
			if (gameState[colour].x + constants.paddleWidth >= gameState.ball.x && gameState[colour].x <= gameState.ball.x + constants.ballWidth) {
				// Player returns the ball!
				gameState.playSound.push('pong_paddle');
				if (colour == 'blue') gameState.ball.y = constants.arenaHeight - constants.ballHeight;
				else if (colour == 'red') gameState.ball.y = constants.ballHeight;
				gameState.ball.direction = angleAfterPaddleReturn(gameState.ball.direction);

				// Increase speed after each successful return
				gameState.ball.speed += constants.ballSpeedIncrement;
				resetInvisibleBall();
			} else {
				// Game Over!
				gameState.playSound.push('pong_miss');
				gameState.winner = oppColour;
				gameState[oppColour].user.score++;
				gameOver(gameState[colour].user);
				console.log(gameState[oppColour].user.username + ' WINS!');
			}
		}
	}
}

// Calculate invisible ball collisions (change directions)
var checkInvisibleBallCollisions = function() {
	// Wall collisions
	if (gameState.invisible_ball.x >= constants.arenaWidth - constants.ballWidth) {
		gameState.invisible_ball.x = constants.arenaWidth - constants.ballWidth;
		gameState.invisible_ball.direction = angleAfterWallBounce(gameState.invisible_ball.direction);
	} else if (gameState.invisible_ball.x <= 0) {
		gameState.invisible_ball.x = 0;
		gameState.invisible_ball.direction = angleAfterWallBounce(gameState.invisible_ball.direction);
	}
}

// Increment ball movement
var updateBallPosition = function() {
	// Real ball
	var radians = degreesToRadians(gameState.ball.direction % 90);
	var h = gameState.ball.speed;
	var a = Math.abs(Math.cos(radians) * gameState.ball.speed);
	var o = Math.abs(Math.sin(radians) * gameState.ball.speed);
	if (gameState.ball.direction < 90) {
		gameState.ball.x += o;
		gameState.ball.y -= a;
	} else if (gameState.ball.direction < 180) {
		gameState.ball.x += a;
		gameState.ball.y += o;
	} else if (gameState.ball.direction < 270) {
		gameState.ball.x -= o;
		gameState.ball.y += a;
	} else {
		gameState.ball.x -= a;
		gameState.ball.y -= o;
	}

	// Invisible ball
	radians = degreesToRadians(gameState.invisible_ball.direction % 90);
	h = gameState.invisible_ball.speed;
	a = Math.abs(Math.cos(radians) * gameState.invisible_ball.speed);
	o = Math.abs(Math.sin(radians) * gameState.invisible_ball.speed);

	// If invisible ball has hit either top or bottom end, stop the ball for now
	if (gameState.invisible_ball.y < 5 || gameState.invisible_ball.y > 480-5) {
	} else if (gameState.invisible_ball.direction < 90) {
		gameState.invisible_ball.x += o;
		gameState.invisible_ball.y -= a;
	} else if (gameState.invisible_ball.direction < 180) {
		gameState.invisible_ball.x += a;
		gameState.invisible_ball.y += o;
	} else if (gameState.invisible_ball.direction < 270) {
		gameState.invisible_ball.x -= o;
		gameState.invisible_ball.y += a;
	} else {
		gameState.invisible_ball.x -= a;
		gameState.invisible_ball.y -= o;
	}
	checkBallCollisions();
	checkInvisibleBallCollisions();
}

// Reset invisible ball to the location of the real ball
var resetInvisibleBall = function() {
	gameState.invisible_ball.x = gameState.ball.x;
	gameState.invisible_ball.y = gameState.ball.y;
	gameState.invisible_ball.direction = gameState.ball.direction;
	gameState.invisible_ball.speed = gameState.ball.speed * constants.invisibleBallSpeedMultiplier;
}

// Update countdown timer display
var updateTimer = function() {
	gameState.timer = '';
	if (gameState.countDown > 0) {
		gameState.countDown--;
		if (gameState.countDown == 3 * constants.countDownDelay ||
			gameState.countDown == 2 * constants.countDownDelay ||
			gameState.countDown == constants.countDownDelay) {
			gameState.playSound.push('pong_countdown');
		}
		if (gameState.countDown / constants.countDownDelay <= 3) {
			gameState.timer = Math.ceil(gameState.countDown / constants.countDownDelay);
		}
		if (gameState.countDown == 0) {
			gameState.playSound.push('pong_start');
			gameState.timer = '';
		}
	}
}

// Paddle position
var updatePaddlePositions = function() {
	var colours = ['blue', 'red'];
	for (var i = 0; i < colours.length; i++) {
		var colour = colours[i];
		if (gameState[colour].user.input.left && !gameState[colour].user.input.right && gameState[colour].stunCounter == 0) {
			gameState[colour].x -= constants.paddleSpeed;
			if (gameState[colour].x < 0) {
				gameState[colour].x = 0;
			}
		}
		if (gameState[colour].user.input.right && !gameState[colour].user.input.left && gameState[colour].stunCounter == 0) {
			gameState[colour].x += constants.paddleSpeed;
			if (gameState[colour].x + constants.paddleWidth > constants.arenaWidth) {
				gameState[colour].x = constants.arenaWidth - constants.paddleWidth;
			}
		}
	}
}

// Bullets and Stun
var updateBulletsAndStun = function() {
	var colours = ['blue', 'red'];
	for (var i = 0; i < colours.length; i++) {
		var colour = colours[i];
		var oppColour = 'blue';
		if (colour == 'blue') oppColour = 'red';

		// Decrement stun counter
		if (gameState[colour].stunCounter > 0) {
			gameState[colour].stunCounter--;
		}

		// Update bullet positions
		if (gameState[colour].bullet) {
			if (colour == 'blue') gameState[colour].bullet.y -= constants.bulletSpeed;
			else if (colour == 'red') gameState[colour].bullet.y += constants.bulletSpeed;

			// Bullet hit the arena boundary
			if ((colour == 'blue' && gameState[colour].bullet.y < constants.bulletHeight) ||
				(colour == 'red' && gameState[colour].bullet.y > constants.arenaHeight - constants.bulletHeight)) {
				if (gameState[colour].bullet.x + constants.bulletWidth >= gameState[oppColour].x &&
					gameState[colour].bullet.x <= gameState[oppColour].x + constants.paddleWidth) {
					// Successful stun
					gameState.playSound.push('pong_stun');
					gameState[oppColour].stunCounter = constants.stunDelay;
				}

				// Remove bullet
				gameState[colour].bullet = null;
			}
		}

		// Fire a new bullet (only if game has started!)
		if (!gameState.isGameOver && gameState.countDown == 0) {
			if (!gameState[colour].bullet && gameState[colour].user.input.fire && gameState[colour].stunCounter == 0) {
				// Fire shot
				gameState.playSound.push('pong_shot');
				gameState[colour].bullet = {};
				gameState[colour].bullet.x = gameState[colour].x + (constants.paddleWidth / 2) - (constants.bulletWidth / 2);
				if (colour == 'blue') gameState[colour].bullet.y = constants.arenaHeight - constants.bulletHeight;
				else gameState[colour].bullet.y = constants.bulletHeight;
			}
		}
	}
}

// Handle CPU artificial intelligence
var doCPU = function() {
	var colours = ['blue', 'red'];
	for (var i = 0; i < colours.length; i++) {
		var colour = colours[i];
		if (gameState[colour].user.username == 'CPU' && gameState[colour].stunCounter == 0) {

			// Removed perfect AI
			// gameState[colour].x = gameState.ball.x - 30;

			// Make the CPU chase the invisible ball

			// Limit CPU speed if ball is lower to make it look a bit more fluid
			var cpu_speed = Math.min(constants.paddleSpeed, gameState.ball.speed);
			var distanceToInvisibleBall = (gameState[colour].x + (constants.paddleWidth / 2)) - (gameState.invisible_ball.x + (constants.bulletWidth / 2));

			// Slow down the CPU as it gets closer to its destination
			if (Math.abs(distanceToInvisibleBall) < cpu_speed * 3) {
				gameState[colour].x -= distanceToInvisibleBall / cpu_speed;
			} else {
				if (distanceToInvisibleBall > 0) gameState[colour].x -= cpu_speed;
				else gameState[colour].x += cpu_speed;
			}

			// Check CPU movement boundaries
			if (gameState[colour].x < 0) {
				gameState[colour].x = 0;
			}
			if (gameState[colour].x + constants.paddleWidth > constants.arenaWidth) {
				gameState[colour].x = constants.arenaWidth - constants.paddleWidth;
			}

			// CPU fires randomly
			gameState[colour].user.input.fire = !gameState[colour].bullet && Math.random() < 0.03;
		}
	}
}

// Send game state data to all connected users
var sendGlobalUpdate = function() {
	var data = {
		gameState: gameState,
		users: users
	}
	io.emit('update', data);
}

// Update the game state for the next frame
var processNextFrame = function() {
	// Server sleeps when there are no players set up
	if (gameState.blue.user && gameState.red.user) {
		// Clear sound data for new frame
		gameState.playSound = [];

		// Update timer display
		updateTimer();

		// Handle paddle movement
		updatePaddlePositions();

		// In-game logic
		if (gameState.countDown == 0 && !gameState.isGameOver) {
			// Handle CPU artificial intelligence
			doCPU();

			// Bullets and Stun
			updateBulletsAndStun();

			// Update ball
			updateBallPosition();
		}

		// Update users with the new frame data
		sendGlobalUpdate();
	}
	setTimeout(processNextFrame, constants.delay);
}
processNextFrame();

// Host server on port 3000
http.listen(3000, function() {
	console.log('listening on *:3000');
});