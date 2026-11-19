const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// ភ្ជាប់ Database (ប្រើ Cloud DATABASE_URL ពេល Online ឬ Localhost ពេលតេស្តលើម៉ាស៊ីន)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:123@localhost:5432/food_db',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
});

// 1. API ទាញបញ្ជីមុខម្ហូបសម្រាប់អតិថិជន
app.get('/api/menus', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM menus WHERE is_available = TRUE ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 1.1 API ទាញមុខម្ហូបទាំងអស់សម្រាប់ Admin
app.get('/api/admin/menus', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM menus ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 1.2 API Admin បន្ថែមមុខម្ហូបថ្មី
app.post('/api/menus', async (req, res) => {
  try {
    const { name, category, price, image_url } = req.body;
    const result = await pool.query(
      `INSERT INTO menus (name, category, price, image_url, is_available) 
       VALUES ($1, $2, $3, $4, TRUE) RETURNING *`,
      [name, category, price, image_url || 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 1.3 API Admin ប្តូរស្ថានភាពស្តុក
app.put('/api/menus/:id/toggle', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `UPDATE menus SET is_available = NOT is_available WHERE id = $1 RETURNING *`,
      [id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 1.4 API Admin លុបមុខម្ហូប
app.delete('/api/menus/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM menus WHERE id = $1', [id]);
    res.json({ message: 'បានលុបមុខម្ហូបជោគជ័យ' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. API ភ្ញៀវបង្កើតការបញ្ជាទិញ
app.post('/api/orders', async (req, res) => {
  try {
    const { customer_name, customer_phone, delivery_address, items } = req.body;
    let total_amount = 0;
    items.forEach(item => { total_amount += item.price * item.quantity; });

    const orderRes = await pool.query(
      `INSERT INTO orders (customer_name, customer_phone, delivery_address, total_amount) 
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [customer_name, customer_phone, delivery_address, total_amount]
    );
    const order = orderRes.rows[0];

    for (let item of items) {
      await pool.query(
        `INSERT INTO order_items (order_id, menu_id, quantity, unit_price) VALUES ($1, $2, $3, $4)`,
        [order.id, item.menu_id, item.quantity, item.price]
      );
    }
    res.status(201).json({ message: 'Order created, waiting for payment', order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. API ពេលធនាគារបញ្ជាក់ថាបង់ប្រាក់រួច
app.post('/api/payment-confirm/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const result = await pool.query(
      `UPDATE orders SET payment_status = 'paid', order_status = 'cooking' 
       WHERE id = $1 RETURNING *`,
      [orderId]
    );
    const paidOrder = result.rows[0];

    io.emit('new_paid_order_to_kitchen', paidOrder);
    io.emit('alert_accountant_payment', {
      message: `ទទួលបានការទូទាត់ $${paidOrder.total_amount} សម្រាប់ Order #${paidOrder.id}`,
      order: paidOrder
    });
    res.json({ message: 'Payment confirmed & Alerts sent!', order: paidOrder });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. API ពេលចុងភៅចុច "DONE"
app.post('/api/kitchen/done/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const result = await pool.query(
      `UPDATE orders SET order_status = 'done' WHERE id = $1 RETURNING *`,
      [orderId]
    );
    const doneOrder = result.rows[0];

    io.emit('order_ready_alert', {
      message: `ម្ហូបសម្រាប់ Order #${doneOrder.id} ចម្អិនរួចរាល់ហើយ!`,
      order: doneOrder
    });
    res.json({ message: 'Order marked as DONE', order: doneOrder });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. API របាយការណ៍បូកសរុបប្រចាំថ្ងៃ
app.get('/api/reports/daily-summary', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(id) AS total_orders,
        COALESCE(SUM(total_amount), 0) AS total_revenue
      FROM orders 
      WHERE payment_status = 'paid' AND DATE(created_at) = CURRENT_DATE
    `);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. API រកមុខម្ហូបដែលបញ្ជាទិញច្រើនជាងគេ
app.get('/api/reports/top-menus', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT m.name, SUM(oi.quantity) AS total_sold
      FROM order_items oi
      JOIN menus m ON oi.menu_id = m.id
      JOIN orders o ON oi.order_id = o.id
      WHERE o.payment_status = 'paid'
      GROUP BY m.id, m.name
      ORDER BY total_sold DESC
      LIMIT 5
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server កំពុងដំណើរការលើ Port ${PORT}`);
});