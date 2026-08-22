import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cors from 'cors';
const app = express();
const server = createServer(app);
const io = new Server(server, {
    cors: {
        origin: "http://localhost:5173",
    },
});
const JWT_SECRET = 'your_jwt_secret_key_change_this'; // Replace with a secure secret
app.use(express.json());
app.use(cors({ origin: 'http://localhost:5173' }));
const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: 'H4bb0RPR0ckz2025!',
    database: 'game'
});
// Helper to get full user from socket
const getUser = async (socket) => {
    const [[user]] = await pool.execute('SELECT * FROM users WHERE id = ?', [socket.data.user_id]);
    return user;
};
// Register endpoint
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
    try {
        const hash = await bcrypt.hash(password, 10);
        const [result] = await pool.execute(
            'INSERT INTO users (username, password_hash) VALUES (?, ?)',
            [username, hash]
        );
        const token = jwt.sign({ user_id: result.insertId }, JWT_SECRET);
        res.json({ token });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Username taken' });
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});
// Login endpoint (include rank)
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
    try {
        const [[user]] = await pool.execute('SELECT * FROM users WHERE username = ?', [username]);
        if (!user || !(await bcrypt.compare(password, user.password_hash))) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const token = jwt.sign({ user_id: user.id }, JWT_SECRET);
        const last_position = [user.last_x || 0, user.last_y || 0, user.last_z || 0];
        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                character_model: user.character_model,
                current_scene: user.current_scene || 1,
                last_position,
                rank: user.rank || 'user'
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});
// Select character endpoint
app.post('/select-character', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token' });
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user_id = decoded.user_id;
        const { model } = req.body;
        if (!model) return res.status(400).json({ error: 'Missing model' });
        // Force full path
        const fullModel = model.startsWith('/') ? model : `/meshy/${model}`;
        await pool.execute('UPDATE users SET character_model = ? WHERE id = ?', [fullModel, user_id]);
        res.json({ success: true });
    } catch (err) {
        res.status(401).json({ error: 'Invalid token' });
    }
});
// Get user data endpoint (include rank)
app.get('/user', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token' });
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user_id = decoded.user_id;
        const [[user]] = await pool.execute(
            'SELECT id, username, character_model, current_scene, last_x, last_y, last_z, rank FROM users WHERE id = ?',
            [user_id]
        );
        if (!user) return res.status(404).json({ error: 'User not found' });
        const last_position = [user.last_x || 0, user.last_y || 0, user.last_z || 0];
        res.json({
            user: {
                id: user.id,
                username: user.username,
                character_model: user.character_model,
                current_scene: user.current_scene || 1,
                last_position,
                rank: user.rank || 'user'
            }
        });
    } catch (err) {
        res.status(401).json({ error: 'Invalid token' });
    }
});
// Get all items in a specific scene
app.get('/scene/:sceneId/items', async (req, res) => {
    const sceneId = parseInt(req.params.sceneId);
    if (isNaN(sceneId)) return res.status(400).json({ error: 'Invalid scene' });
    try {
        const [rows] = await pool.execute(`
            SELECT
                si.id AS instance_id,
                si.scene_id,
                si.pos_x, si.pos_y, si.pos_z,
                si.rotation_y, si.scale,
                si.state,
                i.name,
                i.width, i.height,
                i.is_walkable, i.is_interactable, i.interaction_type
            FROM scene_items si
                     JOIN items i ON si.item_id = i.id
            WHERE si.scene_id = ?
        `, [sceneId]);
        res.json({ items: rows });
    } catch (err) {
        console.error('Error fetching scene items:', err);
        res.status(500).json({ error: 'Server error' });
    }
});
const characters = new Map();
const randomPosition = () => [
    Math.random() * 10 - 5,
    0,
    Math.random() * 10 - 5
];
const randomBrownHexColor = () => {
    const red = Math.floor(Math.random() * 50) + 100;
    const green = Math.floor(Math.random() * 30) + 70;
    const blue = Math.floor(Math.random() * 20) + 30;
    return `#${red.toString(16).padStart(2, '0')}${green.toString(16).padStart(2, '0')}${blue.toString(16).padStart(2, '0')}`;
};
// Socket.IO authentication middleware
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
        return next(new Error('Authentication error: No token'));
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        socket.data.user_id = decoded.user_id;
        next();
    } catch (err) {
        next(new Error('Authentication error: Invalid token'));
    }
});
io.on("connection", async (socket) => {
    const user_id = socket.data.user_id;
    if (!user_id) {
        socket.disconnect();
        return;
    }
    try {
        const [[user]] = await pool.execute('SELECT * FROM users WHERE id = ?', [user_id]);
        if (!user) {
            socket.disconnect();
            return;
        }
        const scene = user.current_scene || 1;
        const position = user.last_x !== null ? [user.last_x, user.last_y, user.last_z] : randomPosition();
        const dogColor = randomBrownHexColor();
        // Always force full path
        let model = user.character_model || '/meshy/male1.glb';
        if (!model.startsWith('/')) model = `/meshy/${model}`;
        characters.set(socket.id, {
            id: socket.id,
            user_id: user_id,
            position,
            dogColor,
            model,
            scene,
            last_update: Date.now()
        });
        socket.join(`scene_${scene}`);
        emitCharactersToScene(scene);
        // Send scene items
        const [rows] = await pool.execute(`
            SELECT
                si.id AS instance_id,
                i.name,
                si.pos_x, si.pos_y, si.pos_z,
                si.rotation_y, si.scale,
                i.width, i.height,
                i.is_walkable, i.is_interactable, i.interaction_type,
                si.state
            FROM scene_items si
                     JOIN items i ON si.item_id = i.id
            WHERE si.scene_id = ?
        `, [scene]);
        socket.emit("scene_items", rows);
        socket.emit("scene_ready");
    } catch (err) {
        console.error('Connection DB error:', err);
        socket.disconnect();
    }
    socket.on("position_update", async (position, callback) => {
        if (!characters.has(socket.id)) {
            if (typeof callback === 'function') {
                callback({ status: 'error', message: 'Character not found' });
            }
            return;
        }

        const character = characters.get(socket.id);
        const oldPosition = [...character.position];
        const dx = position[0] - oldPosition[0];
        const dz = position[2] - oldPosition[2];
        const distMoved = Math.sqrt(dx * dx + dz * dz);

        const now = Date.now();
        const elapsedRaw = (now - character.last_update) / 1000;
        const elapsed = Math.max(elapsedRaw, 0.08);

        // ── EXTREMELY LENIENT SPEED CHECK (debug mode) ──
        const maxSpeed = 3.5;
        const buffer = 20.0;
        const maxAllowed = maxSpeed * elapsed * buffer;

        let accepted = false;

        if (distMoved < 1.5) {
            accepted = true;
        }
        else if (distMoved <= maxAllowed) {
            accepted = true;
        }
        else {
            console.log(
                `Rejection for ${socket.id}: ` +
                `${distMoved.toFixed(2)}m over ${elapsedRaw.toFixed(3)}s ` +
                `(maxAllowed=${maxAllowed.toFixed(2)}m, elapsedRaw=${elapsedRaw.toFixed(3)}s)`
            );

            if (typeof callback === 'function') {
                callback({ status: 'rejected', reason: 'extreme speed', position: oldPosition });
            }
            return;
        }

        // ── Position accepted ──
        character.position = position;
        character.last_update = now;

        try {
            await pool.execute(
                'UPDATE users SET last_x = ?, last_y = ?, last_z = ? WHERE id = ?',
                [...position, character.user_id]
            );

            const [teleports] = await pool.execute(
                'SELECT * FROM teleports WHERE from_scene = ?',
                [character.scene]
            );

            let teleported = false;
            for (const tp of teleports) {
                const dxTp = position[0] - tp.from_x;
                const dzTp = position[2] - tp.from_z;
                const distTp = Math.sqrt(dxTp * dxTp + dzTp * dzTp);

                if (distTp < (tp.radius || 0.5)) {
                    const oldScene = character.scene;
                    character.scene = tp.to_scene;
                    character.position = [tp.to_x, tp.to_y, tp.to_z];

                    await pool.execute(
                        'UPDATE users SET current_scene = ?, last_x = ?, last_y = ?, last_z = ? WHERE id = ?',
                        [character.scene, ...character.position, character.user_id]
                    );

                    socket.leave(`scene_${oldScene}`);
                    socket.join(`scene_${character.scene}`);
                    socket.emit("scene_change", { scene: character.scene, position: character.position });

                    const [rows] = await pool.execute(`
                        SELECT
                            si.id AS instance_id,
                            i.name,
                            si.pos_x, si.pos_y, si.pos_z,
                            si.rotation_y, si.scale,
                            i.width, i.height,
                            i.is_walkable, i.is_interactable, i.interaction_type,
                            si.state
                        FROM scene_items si
                                 JOIN items i ON si.item_id = i.id
                        WHERE si.scene_id = ?
                    `, [character.scene]);

                    socket.emit("scene_items", rows);
                    socket.emit("scene_ready");

                    emitCharactersToScene(oldScene);
                    emitCharactersToScene(character.scene);

                    teleported = true;
                    break;
                }
            }

            if (!teleported) {
                // BATCHED BROADCAST: ~20 Hz for smoother remote movement
                const scene = character.scene;
                if (!socket.data.lastBroadcast || Date.now() - socket.data.lastBroadcast > 50) {
                    socket.data.lastBroadcast = Date.now();
                    emitCharactersToScene(scene);
                }
            }

            if (typeof callback === 'function') {
                callback({ status: 'ok', position: character.position });
            }
        } catch (err) {
            console.error('Save position error:', err);
            character.position = oldPosition;
            if (typeof callback === 'function') {
                callback({ status: 'error', message: 'Failed to save', position: oldPosition });
            }
        }
    });
    // UPDATED: interact_item – added callback for client confirmation
    socket.on('interact_item', async (data, callback) => {
        if (!characters.has(socket.id)) {
            if (callback) callback({ status: 'error', message: 'Character not found' });
            return;
        }
        const character = characters.get(socket.id);
        const { instance_id, type } = data;
        console.log(`[SERVER] Interact request from ${socket.id} → item ${instance_id}, type=${type}`);
        if (type !== 'pickup') {
            console.log(`[SERVER] → Ignoring non-pickup type: ${type}`);
            if (callback) callback({ status: 'invalid_type' });
            return;
        }
        try {
            const [[item]] = await pool.execute(`
                SELECT si.*, i.is_interactable, i.interaction_type
                FROM scene_items si
                         JOIN items i ON si.item_id = i.id
                WHERE si.id = ? AND si.scene_id = ? AND i.is_interactable = 1 AND i.interaction_type = ?
            `, [instance_id, character.scene, type]);
            if (!item) {
                console.log(`[SERVER] → Item ${instance_id} not found or not pickup-able`);
                if (callback) callback({ status: 'not_found' });
                return;
            }
            const dx = character.position[0] - item.pos_x;
            const dz = character.position[2] - item.pos_z;
            const dist = Math.sqrt(dx * dx + dz * dz);
            console.log(`[SERVER] Distance to item ${instance_id}: ${dist.toFixed(2)} m (max 1.5)`);
            if (dist > 1.5) {
                console.log(`[SERVER] → Too far – rejected`);
                if (callback) callback({ status: 'too_far' });
                return;
            }
            console.log(`[SERVER] → Pickup SUCCESS – deleting item ${instance_id}`);
            await pool.execute('DELETE FROM scene_items WHERE id = ?', [instance_id]);
            io.to(`scene_${character.scene}`).emit('remove_item', { instance_id });
            if (callback) callback({ status: 'ok' });
        } catch (err) {
            console.error('Interact item error:', err);
            if (callback) callback({ status: 'error' });
        }
    });
    // NEW: Admin place item
    socket.on('admin_place_item', async (data, callback) => {
        const user = await getUser(socket);
        if (!user || user.rank !== 'admin') {
            return callback({ status: 'error', message: 'Not authorized' });
        }
        const { item_id, pos_x, pos_y = 0, pos_z, rotation_y = 0, scale = 1 } = data;
        const scene_id = data.scene_id || user.current_scene;
        try {
            const [result] = await pool.execute(
                `INSERT INTO scene_items (scene_id, item_id, pos_x, pos_y, pos_z, rotation_y, scale, state)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'normal')`,
                [scene_id, item_id, pos_x, pos_y, pos_z, rotation_y, scale]
            );
            // Fetch full item data for broadcast
            const [[newItem]] = await pool.execute(`
                SELECT
                    si.id AS instance_id,
                    si.scene_id,
                    si.pos_x, si.pos_y, si.pos_z,
                    si.rotation_y, si.scale,
                    si.state,
                    i.name,
                    i.width, i.height,
                    i.is_walkable, i.is_interactable, i.interaction_type
                FROM scene_items si
                         JOIN items i ON si.item_id = i.id
                WHERE si.id = ?
            `, [result.insertId]);
            io.to(`scene_${scene_id}`).emit('add_scene_item', newItem);
            callback({ status: 'ok', instance_id: result.insertId });
        } catch (err) {
            console.error('Place item error:', err);
            callback({ status: 'error', message: 'Database error' });
        }
    });
    // NEW: Admin update item
    socket.on('admin_update_item', async (data, callback) => {
        const user = await getUser(socket);
        if (!user || user.rank !== 'admin') {
            if (typeof callback === 'function') {
                callback({ status: 'error', message: 'Not authorized' });
            }
            return;
        }
        const {
            instance_id,
            pos_x, pos_y, pos_z,
            rotation_y, scale
        } = data;
        if (!instance_id) {
            if (typeof callback === 'function') {
                callback({ status: 'error', message: 'Missing instance_id' });
            }
            return;
        }
        try {
            await pool.execute(
                `UPDATE scene_items
                 SET pos_x = COALESCE(?, pos_x),
                     pos_y = COALESCE(?, pos_y),
                     pos_z = COALESCE(?, pos_z),
                     rotation_y = COALESCE(?, rotation_y),
                     scale = COALESCE(?, scale)
                 WHERE id = ? AND scene_id = ?`,
                [
                    pos_x ?? null,
                    pos_y ?? null,
                    pos_z ?? null,
                    rotation_y ?? null,
                    scale ?? null,
                    instance_id,
                    user.current_scene
                ]
            );
            io.to(`scene_${user.current_scene}`).emit('update_scene_item', {
                instance_id,
                pos_x, pos_y, pos_z, rotation_y, scale
            });
            if (typeof callback === 'function') {
                callback({ status: 'ok' });
            }
        } catch (err) {
            console.error('Update item error:', err);
            if (typeof callback === 'function') {
                callback({ status: 'error', message: 'Database error' });
            }
        }
    });
    // NEW: Admin delete item
    socket.on('admin_delete_item', async (data, callback) => {
        const user = await getUser(socket);
        if (!user || user.rank !== 'admin') {
            return callback({ status: 'error', message: 'Not authorized' });
        }
        const { instance_id } = data;
        try {
            await pool.execute('DELETE FROM scene_items WHERE id = ? AND scene_id = ?', [instance_id, user.current_scene]);
            io.to(`scene_${user.current_scene}`).emit('remove_item', { instance_id });
            callback({ status: 'ok' });
        } catch (err) {
            console.error('Delete item error:', err);
            callback({ status: 'error', message: 'Database error' });
        }
    });
    // NEW: Admin save scene (force reload items for all)
    socket.on('admin_save_scene', async (callback) => {
        const user = await getUser(socket);
        if (!user || user.rank !== 'admin') {
            return callback({ status: 'error', message: 'Not authorized' });
        }
        try {
            const [rows] = await pool.execute(`
                SELECT
                    si.id AS instance_id,
                    si.scene_id,
                    si.pos_x, si.pos_y, si.pos_z,
                    si.rotation_y, si.scale,
                    si.state,
                    i.name,
                    i.width, i.height,
                    i.is_walkable, i.is_interactable, i.interaction_type
                FROM scene_items si
                         JOIN items i ON si.item_id = i.id
                WHERE si.scene_id = ?
            `, [user.current_scene]);
            io.to(`scene_${user.current_scene}`).emit('scene_items', rows);
            callback({ status: 'ok' });
        } catch (err) {
            console.error('Save scene error:', err);
            callback({ status: 'error', message: 'Database error' });
        }
    });
    socket.on("disconnect", async () => {
        if (characters.has(socket.id)) {
            const character = characters.get(socket.id);
            const scene = character.scene;
            try {
                await pool.execute(
                    'UPDATE users SET last_x = ?, last_y = ?, last_z = ? WHERE id = ?',
                    [...character.position, character.user_id]
                );
            } catch (err) {
                console.error('Disconnect save error:', err);
            }
            characters.delete(socket.id);
            emitCharactersToScene(scene);
        }
    });
});
function getCharactersInScene(scene) {
    return Array.from(characters.values()).filter(c => c.scene === scene);
}
function emitCharactersToScene(scene) {
    io.to(`scene_${scene}`).emit("characters", getCharactersInScene(scene));
}
server.listen(3001, () => {
    console.log('Server listening on port 3001');
});