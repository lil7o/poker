const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let gameState = {
    players: {},
    pot: 0,
    currentHighestBet: 0
};

io.on('connection', (socket) => {
    console.log(`Jugador conectado: ${socket.id}`);

    socket.on('join-game', ({ name, initialChips }) => {
        let cleanName = name || `Jugador ${Object.keys(gameState.players).length + 1}`;
        let defaultChips = parseInt(initialChips) || 1000;

        if (gameState.players[socket.id]) {
            gameState.players[socket.id].name = cleanName;
        } else {
            let existingKey = Object.keys(gameState.players).find(id => gameState.players[id].name === cleanName);
            
            if (existingKey) {
                let oldPlayer = gameState.players[existingKey];
                delete gameState.players[existingKey];
                gameState.players[socket.id] = oldPlayer;
                gameState.players[socket.id].id = socket.id;
            } else {
                gameState.players[socket.id] = {
                    id: socket.id,
                    name: cleanName,
                    chips: defaultChips,
                    currentBet: 0,
                    folded: false
                };
            }
        }

        io.emit('update-game', gameState);
    });

    socket.on('logout-player', () => {
        if (gameState.players[socket.id]) {
            delete gameState.players[socket.id];
            io.emit('update-game', gameState);
        }
    });

    socket.on('place-bet', (amount) => {
        let player = gameState.players[socket.id];
        if (!player || player.folded || player.chips <= 0) return;

        if (amount > player.chips) return;

        player.chips -= amount;
        player.currentBet += amount;
        gameState.pot += amount;

        if (player.currentBet > gameState.currentHighestBet) {
            gameState.currentHighestBet = player.currentBet;
        }

        io.emit('update-game', gameState);
    });

    socket.on('call', () => {
        let player = gameState.players[socket.id];
        if (!player || player.folded || player.chips <= 0) return;

        let difference = gameState.currentHighestBet - player.currentBet;
        if (difference <= 0) return;

        if (difference > player.chips) {
            difference = player.chips;
        }

        player.chips -= difference;
        player.currentBet += difference;
        gameState.pot += difference;

        io.emit('update-game', gameState);
    });

    socket.on('fold', () => {
        let player = gameState.players[socket.id];
        if (player) {
            player.folded = true;
            io.emit('update-game', gameState);
        }
    });

    socket.on('win-pot', (winnerId) => {
        let winner = gameState.players[winnerId];
        if (!winner || winner.folded || (winner.chips <= 0 && winner.currentBet === 0)) return;

        let activePlayers = Object.values(gameState.players).filter(p => !p.folded && (p.chips > 0 || p.currentBet > 0));
        if (activePlayers.length > 2) return;

        winner.chips += gameState.pot;
        gameState.pot = 0;
        gameState.currentHighestBet = 0;
        
        Object.values(gameState.players).forEach(p => {
            p.currentBet = 0;
            p.folded = false;
        });
        io.emit('update-game', gameState);
    });

    // NUEVO: Repartir Pozo (Split Pot)
    socket.on('split-pot', () => {
        let activePlayers = Object.values(gameState.players).filter(p => !p.folded && (p.chips > 0 || p.currentBet > 0));
        if (activePlayers.length === 0 || gameState.pot <= 0) return;

        let share = Math.floor(gameState.pot / activePlayers.length);
        let remainder = gameState.pot % activePlayers.length;

        activePlayers.forEach((p, index) => {
            p.chips += share + (index < remainder ? 1 : 0);
        });

        gameState.pot = 0;
        gameState.currentHighestBet = 0;

        Object.values(gameState.players).forEach(p => {
            p.currentBet = 0;
            p.folded = false;
        });

        io.emit('update-game', gameState);
    });

    socket.on('reset-hand', () => {
        gameState.pot = 0;
        gameState.currentHighestBet = 0;
        Object.values(gameState.players).forEach(p => {
            p.currentBet = 0;
            p.folded = false;
        });
        io.emit('update-game', gameState);
    });

    socket.on('reset-all-game', () => {
        gameState = {
            players: {},
            pot: 0,
            currentHighestBet: 0
        };
        io.emit('update-game', gameState);
    });

    socket.on('disconnect', () => {
        console.log(`Jugador desconectado: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});
