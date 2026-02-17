const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cors = require('cors');
const midtransClient = require('midtrans-client');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Configuration
const IS_PRODUCTION = process.env.IS_PRODUCTION === 'true';

// Connect to MongoDB (Serverless Pattern)
const MONGODB_URI = process.env.MONGODB_URI;

let cached = global.mongoose;
if (!cached) {
    cached = global.mongoose = { conn: null, promise: null };
}

async function connectDB() {
    if (cached.conn) return cached.conn;

    if (!cached.promise) {
        const opts = {
            bufferCommands: false, // Disable mongoose buffering
        };
        cached.promise = mongoose.connect(MONGODB_URI, opts).then((mongoose) => {
            return mongoose;
        });
    }

    try {
        cached.conn = await cached.promise;
    } catch (e) {
        cached.promise = null;
        throw e;
    }

    return cached.conn;
}

// Only connect if URI is present
if (!MONGODB_URI) {
    console.warn('MONGODB_URI is not set. Database features will not work.');
}

// Define Schema & Model
const TransactionSchema = new mongoose.Schema({
    order_id: { type: String, required: true, unique: true },
    name: String,
    phone: String, // New
    amount: Number,
    month: String,
    status: { type: String, default: 'PENDING' },
    token: String, // Midtrans Snap Token
    gateway: { type: String, default: 'MIDTRANS' }, // 'MIDTRANS' or 'KLIKQRIS'
    signature: String, // KlikQRIS Signature
    qris_url: String, // KlikQRIS Image URL
    created_at: { type: Date, default: Date.now },
    updated_at: Date
});

const Transaction = mongoose.model('Transaction', TransactionSchema);

// Midtrans Clients
let snap = new midtransClient.Snap({
    isProduction: IS_PRODUCTION,
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY
});

let coreApi = new midtransClient.CoreApi({
    isProduction: IS_PRODUCTION,
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY
});

// Helper: Send WhatsApp
async function sendNotification(phone, message) {
    if (!phone) return;
    try {
        // Format Phone: Ensure it starts with 62 and ends with @s.whatsapp.net
        // Remove non-numeric
        let formattedPhone = phone.replace(/\D/g, '');
        if (formattedPhone.startsWith('0')) formattedPhone = '62' + formattedPhone.slice(1);

        // Ensure format for gateway
        if (!formattedPhone.endsWith('@s.whatsapp.net')) formattedPhone += '@s.whatsapp.net';

        const userId = 'patrolwaa1'; // hardcoded based on request
        const url = `https://wa-api.pnblk.my.id/send-text?userId=${userId}&to=${formattedPhone}&message=${encodeURIComponent(message)}`;
        console.log(`Sending WA URL: ${url}`);

        await axios.get(url);
        console.log(`Axios call complete`);
        console.log(`✅ WhatsApp sent to ${phone}`);
    } catch (error) {
        console.error(`❌ WA Error: ${error.message} \n URL: ${error.config?.url}`);
    }
}


// --- Routes ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// 1. Create Transaction
app.post('/create-transaction', async (req, res) => {
    try {
        await connectDB();
        const { amount, description, customer_details, month, gateway } = req.body;

        // Generate unique Order ID (Shortened for Midtrans limit)
        const orderId = `YT-${Date.now()}`;

        console.log(`Creating transaction for Order ID: ${orderId}, Amount: ${amount}, Gateway: ${gateway || 'MIDTRANS'}`);

        // --- KLIKQRIS LOGIC ---
        if (gateway === 'KLIKQRIS') {
            const formattedAmount = parseInt(amount);
            const merchantId = parseInt(process.env.KLIKQRIS_MERCHANT_ID);
            const apiKey = process.env.KLIKQRIS_API_KEY;

            try {
                const response = await axios.post('https://klikqris.com/api/qris/create', {
                    order_id: orderId,
                    amount: formattedAmount,
                    id_merchant: merchantId,
                    keterangan: description || `Payment for ${month}`
                }, {
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': apiKey,
                        'id_merchant': merchantId
                    }
                });

                const data = response.data;
                if (!data.status) throw new Error(data.message || 'KlikQRIS Failed');

                const result = data.data;

                // Save to MongoDB
                const newTx = new Transaction({
                    order_id: orderId,
                    name: customer_details.first_name,
                    phone: customer_details.phone,
                    amount: result.total_amount, // Use total (with unique code)
                    month: month,
                    status: 'PENDING',
                    gateway: 'KLIKQRIS',
                    signature: result.signature,
                    qris_url: result.qris_url
                });
                await newTx.save();

                return res.json({
                    status: true,
                    data: {
                        gateway: 'KLIKQRIS',
                        order_id: orderId,
                        signature: result.signature,
                        qris_url: result.qris_url,
                        total_amount: result.total_amount
                    }
                });

            } catch (kqError) {
                const errorMsg = kqError.response ? JSON.stringify(kqError.response.data) : kqError.message;
                console.error('KlikQRIS API Error:', errorMsg);
                return res.status(500).json({ status: false, message: 'KlikQRIS Error: ' + errorMsg });
            }
        }

        // --- MIDTRANS LOGIC (Default) ---
        let parameter = {
            "transaction_details": {
                "order_id": orderId,
                "gross_amount": parseInt(amount)
            },
            "credit_card": { "secure": true },
            "customer_details": customer_details || {
                "first_name": "Member",
                "email": "member@example.com",
            },
            "item_details": [{
                "id": `YT-PREMIUM-${month}`,
                "price": parseInt(amount),
                "quantity": 1,
                "name": description || "YouTube Premium Share"
            }]
        };

        const transaction = await snap.createTransaction(parameter);

        // Save to MongoDB
        const newTx = new Transaction({
            order_id: orderId,
            name: customer_details.first_name,
            phone: customer_details.phone,
            amount: parseInt(amount),
            month: month,
            status: 'PENDING',
            token: transaction.token,
            gateway: 'MIDTRANS'
        });
        await newTx.save();

        res.json({
            status: true,
            data: {
                gateway: 'MIDTRANS',
                token: transaction.token,
                order_id: orderId,
                redirect_url: transaction.redirect_url
            }
        });

    } catch (error) {
        console.error('Error creating transaction:', error.message);
        res.status(500).json({ status: false, message: error.message });
    }
});

// 2. Admin: Get Transactions (Sorted by newest)
app.get('/api/transactions', async (req, res) => {
    try {
        await connectDB();
        const transactions = await Transaction.find().sort({ created_at: -1 });
        res.json(transactions);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2b. Public: Get Summary (Total Collected)
app.get('/api/summary', async (req, res) => {
    try {
        await connectDB();
        const { month } = req.query;
        if (!month) return res.json({ total: 0, count: 0 });

        const transactions = await Transaction.find({
            month: month,
            status: { $in: ['SUCCESS', 'settlement', 'capture'] }
        });

        const total = transactions.reduce((acc, curr) => acc + curr.amount, 0);
        const count = transactions.length;

        res.json({
            total: total,
            count: count,
            target: 159000,
            target_count: 6
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Manual Status Check
app.get('/api/transaction/:orderId/check', async (req, res) => {
    const { orderId } = req.params;
    console.log(`Checking status for ${orderId}...`);

    try {
        await connectDB();
        const statusResponse = await coreApi.transaction.status(orderId);
        let transactionStatus = statusResponse.transaction_status;
        let fraudStatus = statusResponse.fraud_status;

        console.log(`Status Response: ${transactionStatus}`);

        let status = 'PENDING';
        if (transactionStatus == 'capture') {
            if (fraudStatus == 'challenge') {
                status = 'CHALLENGE';
            } else if (fraudStatus == 'accept') {
                status = 'SUCCESS';
            }
        } else if (transactionStatus == 'settlement') {
            status = 'SUCCESS';
        } else if (transactionStatus == 'deny') {
            status = 'FAILED';
        } else if (transactionStatus == 'cancel' || transactionStatus == 'expire') {
            status = 'FAILED';
        } else if (transactionStatus == 'pending') {
            status = 'PENDING';
        }

        // Check current status in DB to avoid double notification
        const currentTx = await Transaction.findOne({ order_id: orderId });
        const previousStatus = currentTx ? currentTx.status : 'PENDING';
        console.log(`Previous DB Status: ${previousStatus}`);

        // Update DB
        const updatedTx = await Transaction.findOneAndUpdate(
            { order_id: orderId },
            { status: status, updated_at: new Date() },
            { new: true } // Return updated doc
        );

        console.log(`Updated Status: ${status}`);
        console.log(`Phone in DB: ${updatedTx ? updatedTx.phone : 'No Data'}`);

        // Send WA Notification if Success AND it's a NEW success (prev status was not success)
        if (status === 'SUCCESS' && previousStatus !== 'SUCCESS' && updatedTx && updatedTx.phone) {
            console.log(`Attempting to send WA to ${updatedTx.phone}...`);
            const msg = `*Pembayaran Diterima!*\n\nHalo ${updatedTx.name},\nPembayaran YouTube Premium Anda sebesar Rp ${updatedTx.amount.toLocaleString()} untuk bulan ${updatedTx.month} telah berhasil.\n\nTerima kasih! 🎉`;
            await sendNotification(updatedTx.phone, msg);
        } else {
            console.log(`WA Logic Skipped: Pre-Fail=${previousStatus !== 'SUCCESS'}, HasPhone=${!!(updatedTx && updatedTx.phone)}`);
        }

        res.json({ status: true, data: { status: status, original: statusResponse, db: updatedTx } });

    } catch (e) {
        console.error("Error checking status:", e.message);
        res.status(500).json({ status: false, message: e.message });
    }
});

// 3b. Delete Transaction (Admin)
app.delete('/api/transaction/:orderId', async (req, res) => {
    try {
        await connectDB();
        const { orderId } = req.params;
        await Transaction.findOneAndDelete({ order_id: orderId });
        res.json({ status: true, message: 'Transaction deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3c. Send WA Manual (Proxy)
app.post('/api/send-wa', async (req, res) => {
    try {
        const { phone, message } = req.body;
        if (!phone || !message) return res.status(400).json({ status: false, message: 'Missing phone or message' });

        await sendNotification(phone, message);
        res.json({ status: true, message: 'Sent' });
    } catch (err) {
        res.status(500).json({ status: false, message: err.message });
    }
});

// 4. Webhook
app.post('/notification', async (req, res) => {
    try {
        await connectDB();
        const statusResponse = await coreApi.transaction.notification(req.body);
        const orderId = statusResponse.order_id;
        const transactionStatus = statusResponse.transaction_status;
        const fraudStatus = statusResponse.fraud_status;

        console.log(`Webhook received: ${orderId} | Status: ${transactionStatus}`);

        let status = 'PENDING';
        if (transactionStatus == 'capture') {
            if (fraudStatus == 'challenge') {
                status = 'CHALLENGE';
            } else if (fraudStatus == 'accept') {
                status = 'SUCCESS';
            }
        } else if (transactionStatus == 'settlement') {
            status = 'SUCCESS';
        } else if (transactionStatus == 'deny') {
            status = 'FAILED';
        } else if (transactionStatus == 'cancel' || transactionStatus == 'expire') {
            status = 'FAILED';
        }

        // Update DB
        const updatedTx = await Transaction.findOneAndUpdate(
            { order_id: orderId },
            { status: status, updated_at: new Date() },
            { new: true }
        );

        // Send WA Notification if Success and not already sent (simple check)
        if (status === 'SUCCESS' && updatedTx && updatedTx.phone) {
            const msg = `*Pembayaran Diterima!*\n\nHalo ${updatedTx.name},\nPembayaran YouTube Premium Anda sebesar Rp ${updatedTx.amount.toLocaleString()} untuk bulan ${updatedTx.month} telah berhasil.\n\nTerima kasih! 🎉`;
            await sendNotification(updatedTx.phone, msg);
        }

        res.status(200).send('OK');
    } catch (err) {
        console.error('Webhook Error:', err.message);
        res.status(500).send('Error');
    }
});

// --- Auto Check Background Job (Local Only) ---
async function checkPendingTransactions() {
    console.log('🔄 Auto-Checking Pending Transactions...');
    try {
        await connectDB();
        const pendingTxs = await Transaction.find({ status: 'PENDING' });
        if (pendingTxs.length === 0) {
            console.log('No pending transactions.');
            return;
        }

        for (const tx of pendingTxs) {
            try {
                const statusResponse = await coreApi.transaction.status(tx.order_id);
                let transactionStatus = statusResponse.transaction_status;
                let fraudStatus = statusResponse.fraud_status;
                let newStatus = 'PENDING';

                if (transactionStatus == 'capture') {
                    if (fraudStatus == 'challenge') newStatus = 'CHALLENGE';
                    else if (fraudStatus == 'accept') newStatus = 'SUCCESS';
                } else if (transactionStatus == 'settlement') {
                    newStatus = 'SUCCESS';
                } else if (transactionStatus == 'deny' || transactionStatus == 'cancel' || transactionStatus == 'expire') {
                    newStatus = 'FAILED';
                }

                if (newStatus !== 'PENDING' && newStatus !== tx.status) {
                    tx.status = newStatus;
                    tx.updated_at = new Date();
                    await tx.save();

                    console.log(`✅ Status Updated: ${tx.order_id} -> ${newStatus}`);

                    if (newStatus === 'SUCCESS' && tx.phone) {
                        const msg = `*Pembayaran Diterima!*\n\nHalo ${tx.name},\nPembayaran YouTube Premium Anda sebesar Rp ${tx.amount.toLocaleString()} untuk bulan ${tx.month} telah berhasil.\n\nTerima kasih! 🎉`;
                        await sendNotification(tx.phone, msg);
                    }
                }
            } catch (err) {
                console.error(`Failed to check ${tx.order_id}:`, err.message);
            }
        }
    } catch (err) {
        console.error('Auto-Check Error:', err.message);
    }
}


// Vercel Serverless Export
module.exports = app;

// Local Development
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);

        // Start Auto-Check every 1 minute
        // setInterval(checkPendingTransactions, 10 * 1000);
        // checkPendingTransactions(); // Run once immediately
    });
}
