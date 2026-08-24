require('dotenv').config();

const crypto = require('crypto');

const API_KEY = process.env.BINANCE_API_KEY;
const SECRET_KEY = process.env.BINANCE_API_SECRET;

function sign(query) {
    return crypto
        .createHmac('sha256', SECRET_KEY)
        .update(query)
        .digest('hex');
}

async function signedRequest(path, extra = {}) {
    const params = new URLSearchParams();

    for (const [key, value] of Object.entries(extra)) {
        params.set(key, String(value));
    }

    params.set('recvWindow', '10000');
    params.set('timestamp', String(Date.now()));

    const query = params.toString();
    params.set('signature', sign(query));

    const response = await fetch(
        `https://api.binance.com${path}?${params.toString()}`,
        {
            headers: {
                'X-MBX-APIKEY': API_KEY
            }
        }
    );

    const text = await response.text();

    console.log('\nHTTP:', response.status);

    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

async function main() {

    console.log('============================');
    console.log('1. TEST API KEY');
    console.log('============================');

    const permissions = await signedRequest(
        '/sapi/v1/account/apiRestrictions'
    );

    console.log(permissions);

    console.log('\n============================');
    console.log('2. BINANCE PAY HISTORY');
    console.log('============================');

    const now = Date.now();

    const history = await signedRequest(
        '/sapi/v1/pay/transactions',
        {
            startTime: now - (24 * 60 * 60 * 1000),
            endTime: now,
            limit: 100
        }
    );

    console.log(JSON.stringify(history, null, 2));

    console.log('\n============================');
    console.log('3. TRANSACTIONS');
    console.log('============================');

    if (Array.isArray(history?.data)) {

        for (const tx of history.data) {

            console.log('----------------------------');

            console.log('Transaction ID:', tx.transactionId);
            console.log('Type:', tx.orderType);
            console.log('Amount:', tx.amount);
            console.log('Currency:', tx.currency);
            console.log(
                'Time:',
                new Date(tx.transactionTime).toISOString()
            );

            console.log(
                'Sender:',
                tx.payerInfo
            );

            console.log(
                'Receiver:',
                tx.receiverInfo
            );
        }

    } else {
        console.log('No transaction array returned.');
    }
}

main().catch(console.error);
