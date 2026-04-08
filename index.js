const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const VERIFY_TOKEN    = process.env.VERIFY_TOKEN || 'dra-rosina-2024';
const WHATSAPP_TOKEN  = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const PORT            = process.env.PORT || 3000;

const clientes = {};

const SYSTEM_PROMPT = `Eres el asistente virtual del Consultorio de la Dra. Rosina, especialista en medicina estética.
Tu nombre es Rosina Bot. Responde SIEMPRE en español de México, con tono cálido, profesional y amable.
Sé conciso, máximo 3-4 oraciones por mensaje. Usa emojis con moderación.

FLUJO OBLIGATORIO (sigue este orden exacto):
1. Saluda al cliente y pide su nombre y apellido para registrarlo.
2. Una vez que tengas nombre y apellido, confirma el registro y muestra los servicios disponibles.
3. Pregunta qué servicio le interesa y cuándo gusta agendar.
4. Muestra los horarios disponibles:
   Lunes: 10:00, 11:00, 13:00, 16:00
   Martes: 09:00, 11:30, 15:00, 17:00
   Miércoles: 10:00, 12:00, 14:30
   Jueves: 09:30, 11:00, 16:00, 17:30
   Viernes: 10:00, 13:00, 15:00
5. Cuando el cliente elija día y hora, confirma la cita con todos los detalles.
   Menciona que recibirá un recordatorio 1 hora antes de su cita.
6. Termina con una despedida cálida.

SERVICIOS DISPONIBLES:
- Botox / Toxina botulínica
- Rellenos de ácido hialurónico
- Limpieza facial
- Tratamientos láser
- Mesoterapia

REGLAS:
- No repitas preguntas ya respondidas.
- Detecta nombre y apellido en los mensajes y úsalos naturalmente.
- Cuando confirmes la cita incluye: nombre, servicio, día y hora.`;

async function sendMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log(`✅ Mensaje enviado a ${to}`);
  } catch (err) {
    console.error('❌ Error enviando mensaje:', err.response?.data || err.message);
  }
}

async function getAIResponse(phone, userMessage) {
  if (!clientes[phone]) {
    clientes[phone] = { phone, nombre: null, servicio: null, cita: null, historial: [], recordatorioSet: false, retoqueSet: false };
  }
  const cliente = clientes[phone];
  cliente.historial.push({ role: 'user', content: userMessage });

  if (!cliente.nombre) {
    const m = userMessage.match(/\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{1,})\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{1,})\b/);
    if (m) cliente.nombre = m[1] + ' ' + m[2];
  }

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-haiku-4-5-20251001', max_tokens: 500, system: SYSTEM_PROMPT, messages: cliente.historial },
      { headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } }
    );

    const reply = response.data.content.map(b => b.text || '').join('');
    cliente.historial.push({ role: 'assistant', content: reply });

    if (!cliente.servicio) {
      const smap = { botox: 'Botox/Toxina botulínica', toxina: 'Botox/Toxina botulínica', relleno: 'Rellenos de ácido hialurónico', limpieza: 'Limpieza facial', láser: 'Tratamientos láser', laser: 'Tratamientos láser', mesoterapia: 'Mesoterapia' };
      const texto = (userMessage + ' ' + reply).toLowerCase();
      Object.entries(smap).forEach(([k, v]) => { if (!cliente.servicio && texto.includes(k)) cliente.servicio = v; });
    }

    if (!cliente.cita) {
      const days = ['lunes','martes','miércoles','miercoles','jueves','viernes'];
      const tm = reply.match(/\b(\d{1,2}:\d{2})\b/);
      const day = days.find(d => reply.toLowerCase().includes(d));
      if (tm && day) {
        cliente.cita = day.charAt(0).toUpperCase() + day.slice(1) + ' a las ' + tm[1];
        programarRecordatorios(phone);
      }
    }

    return reply;
  } catch (err) {
    console.error('❌ Error con Claude:', err.response?.data || err.message);
    return 'Disculpe, tuve un problema técnico. Por favor intente de nuevo en un momento. 🙏';
  }
}

function programarRecordatorios(phone) {
  const cliente = clientes[phone];
  if (!cliente || cliente.recordatorioSet) return;
  cliente.recordatorioSet = true;

  const esPrueba = process.env.NODE_ENV !== 'production';
  const msRecordatorio = esPrueba ? 1 * 60 * 1000 : 60 * 60 * 1000;
  const msRetoque      = esPrueba ? 5 * 60 * 1000 : 5 * 30 * 24 * 60 * 60 * 1000;

  setTimeout(async () => {
    await sendMessage(phone, `⏰ Recordatorio: Hola ${cliente.nombre || ''}, le recordamos su cita con la Dra. Rosina ${cliente.cita ? 'el ' + cliente.cita : 'próximamente'}. ¡La esperamos! 💐`);
  }, msRecordatorio);

  setTimeout(async () => {
    if (!cliente.retoqueSet) {
      cliente.retoqueSet = true;
      await sendMessage(phone, `✨ Hola ${cliente.nombre || ''}, han pasado 5 meses desde su última visita al Consultorio de la Dra. Rosina. ¡Le toca su retoque de ${cliente.servicio || 'tratamiento'}! ¿Le agendamos? 😊`);
    }
  }, msRetoque);
}

// Verificación webhook
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verificado');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Recibir mensajes
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message?.text?.body) return;
    const phone = message.from;
    const text = message.text.body;
    console.log(`📨 Mensaje de ${phone}: ${text}`);
    const reply = await getAIResponse(phone, text);
    await sendMessage(phone, reply);
  } catch (err) {
    console.error('❌ Error en webhook:', err.message);
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', bot: 'Consultorio de la Dra. Rosina', clientes: Object.keys(clientes).length });
});

app.listen(PORT, () => console.log(`🚀 Bot Dra. Rosina corriendo en puerto ${PORT}`));
