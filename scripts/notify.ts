import https from 'https';
import http from 'http';

// Konfigurace pro WhatsApp (přes Twilio API)
const TWILIO_SID = process.env.TWILIO_SID || 'VASE_TWILIO_SID';
const TWILIO_TOKEN = process.env.TWILIO_TOKEN || 'VAS_TWILIO_TOKEN';
const WHATSAPP_FROM = process.env.WHATSAPP_FROM || 'whatsapp:+14155238886';
const WHATSAPP_TO = process.env.WHATSAPP_TO || 'whatsapp:+420123456789';

// Konfigurace pro Telegram (přes oficiální Bot API)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'VAS_TELEGRAM_BOT_TOKEN';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || 'VAS_CHAT_ID';

function sendWhatsAppMessage(message: string) {
  const postData = new URLSearchParams({
    To: WHATSAPP_TO,
    From: WHATSAPP_FROM,
    Body: message
  }).toString();

  const options = {
    hostname: 'api.twilio.com',
    port: 443,
    path: `/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
    method: 'POST',
    auth: `${TWILIO_SID}:${TWILIO_TOKEN}`,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': postData.length
    }
  };

  const req = https.request(options, (res) => {
    console.log(`WhatsApp API Status: ${res.statusCode}`);
  });
  req.on('error', (e) => console.error(`WhatsApp Chyba: ${e.message}`));
  req.write(postData);
  req.end();
}

function sendTelegramMessage(message: string) {
  const postData = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text: message,
    parse_mode: 'HTML'
  });

  const options = {
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  const req = https.request(options, (res) => {
    console.log(`Telegram API Status: ${res.statusCode}`);
  });

  req.on('error', (e) => {
    console.error(`Telegram Chyba: ${e.message}`);
  });
  
  req.write(postData);
  req.end();
}

const message = process.argv[2] || '🚀 <b>Antigravity:</b> Nová verze byla úspěšně otestována a nasazena (Architektura 100% čistá)!';

console.log('Odesílám notifikace...');
// sendWhatsAppMessage(message);
// sendTelegramMessage(message);
console.log(`Zpráva k odeslání: "${message}"`);

