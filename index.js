const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { Pool } = require('pg');
const app = express();
app.use(express.json());

const VERIFY_TOKEN         = process.env.VERIFY_TOKEN || 'dra-rosina-2024';
const WHATSAPP_TOKEN       = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID      = process.env.PHONE_NUMBER_ID;
const ANTHROPIC_KEY        = process.env.ANTHROPIC_API_KEY;
const GOOGLE_SERVICE_EMAIL = process.env.GOOGLE_SERVICE_EMAIL;
const GOOGLE_PRIVATE_KEY   = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const GOOGLE_CALENDAR_ID   = process.env.GOOGLE_CALENDAR_ID || 'melissavargass16@gmail.com';
const DATABASE_URL         = process.env.DATABASE_URL;
const PORT                 = process.env.PORT || 3000;
const AGENDA_BASE          = 'https://calendly.com/melissavargass16/dra-rosina';

const SERVICIOS = [
  'Botox / Toxina botulinica',
  'Rellenos de acido hialuronico',
  'Limpieza facial',
  'Tratamientos laser',
  'Mesoterapia'
];

const RELACIONADOS = {
  'Botox / Toxina botulinica':     ['Rellenos de acido hialuronico', 'Mesoterapia'],
  'Rellenos de acido hialuronico': ['Botox / Toxina botulinica', 'Tratamientos laser'],
  'Limpieza facial':               ['Mesoterapia', 'Tratamientos laser'],
  'Tratamientos laser':            ['Limpieza facial', 'Mesoterapia'],
  'Mesoterapia':                   ['Botox / Toxina botulinica', 'Limpieza facial']
};

const SYS = 'Eres Bon, asistente femenina del Consultorio de la Dra. Rosina. Responde en espanol de Mexico, tono calido, amable y cercano. Max 3 oraciones. Nunca digas que eres IA o bot. Usa el historial del cliente naturalmente.';

const E = {
  I:  'inicio',
  N:  'nombre',
  CN: 'confirmar_nombre',
  C:  'correo',
  CC: 'confirmar_correo',
  S:  'servicio',
  CF: 'confirmar_servicio',
  CA: 'cancelar',
  L:  'libre'
};

// ─── POSTGRESQL ─────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clientes (
        phone TEXT PRIMARY KEY,
        nombre TEXT,
        correo TEXT,
        ultimo_srv TEXT,
        creado_at TIMESTAMP DEFAULT NOW(),
        actualizado_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('DB lista');
  } catch(e) {
    console.error('initDB:', e.message);
  }
}

async function getClienteDB(phone) {
  try {
    const res = await pool.query('SELECT * FROM clientes WHERE phone = $1', [phone]);
    return res.rows[0] || null;
  } catch(e) {
    console.error('getClienteDB:', e.message);
    return null;
  }
}

async function saveClienteDB(phone, nombre, correo, ultimoSrv) {
  try {
    await pool.query(`
      INSERT INTO clientes (phone, nombre, correo, ultimo_srv, actualizado_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (phone) DO UPDATE
      SET nombre = $2, correo = $3, ultimo_srv = $4, actualizado_at = NOW()
    `, [phone, nombre, correo, ultimoSrv]);
  } catch(e) {
    console.error('saveClienteDB:', e.message);
  }
}

// ─── SESIONES EN MEMORIA (solo estado de conversacion) ─────────────
const sesiones = {};

async function getCliente(phone) {
  if (!sesiones[phone]) {
    const guardado = await getClienteDB(phone);
    sesiones[phone] = {
      phone,
      nombre:        guardado?.nombre     || null,
      correo:        guardado?.correo     || null,
      ultimoSrv:     guardado?.ultimo_srv || null,
      estado:        E.I,
      nombreTemp:    null,
      correoTemp:    null,
      srvPendiente:  null,
      retSet:        false,
    };
  }
  return sesiones[phone];
}

async function guardarCliente(c) {
  await saveClienteDB(c.phone, c.nombre, c.correo, c.ultimoSrv);
}

function capitalizarNombre(str) {
  return str.trim().replace(/\b\w/g, l => l.toUpperCase());
}

// ─── GOOGLE SERVICE ACCOUNT JWT ────────────────────────────────────
let googleAccessToken = null;
let googleTokenExpiry = 0;

function base64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function getGoogleToken() {
  if (googleAccessToken && Date.now() < googleTokenExpiry - 60000) {
    return googleAccessToken;
  }
  try {
    const now = Math.floor(Date.now() / 1000);
    const header  = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(JSON.stringify({
      iss: GOOGLE_SERVICE_EMAIL,
      scope: 'https://www.googleapis.com/auth/calendar',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now
    }));
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(header + '.' + payload);
    const signature = sign.sign(GOOGLE_PRIVATE_KEY, 'base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const jwt = header + '.' + payload + '.' + signature;
    const res = await axios.post('https://oauth2.googleapis.com/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    });
    googleAccessToken = res.data.access_token;
    googleTokenExpiry = Date.now() + (res.data.expires_in * 1000);
    console.log('Google token OK');
    return googleAccessToken;
  } catch(e) {
    console.error('getGoogleToken:', e.response?.data || e.message);
    return null;
  }
}

// ─── GOOGLE CALENDAR ───────────────────────────────────────────────
async function getCitaActivaGoogle(nombre) {
  try {
    const token = await getGoogleToken();
    if (!token) return null;
    const ahora = new Date().toISOString();
    const res = await axios.get(
      'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(GOOGLE_CALENDAR_ID) + '/events',
      {
        headers: { Authorization: 'Bearer ' + token },
        params: { timeMin: ahora, singleEvents: true, orderBy: 'startTime', maxResults: 50 }
      }
    );
    const eventos = res.data.items || [];
    const nombreLower = nombre.toLowerCase().split(' ')[0];
    const cita = eventos.find(ev => {
      const titulo = (ev.summary || '').toLowerCase();
      const desc   = (ev.description || '').toLowerCase();
      return titulo.includes(nombreLower) || desc.includes(nombreLower);
    });
    console.log('Cita encontrada:', cita ? cita.summary : 'ninguna');
    return cita || null;
  } catch(e) {
    console.error('getCitaActivaGoogle:', e.response?.data || e.message);
    return null;
  }
}

async function cancelarCitaGoogle(eventId) {
  try {
    const token = await getGoogleToken();
    if (!token) return false;
    await axios.delete(
      'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(GOOGLE_CALENDAR_ID) + '/events/' + eventId,
      { headers: { Authorization: 'Bearer ' + token } }
    );
    return true;
  } catch(e) {
    console.error('cancelarCitaGoogle:', e.response?.data || e.message);
    return false;
  }
}

function formatFecha(evento) {
  const inicio = evento.start?.dateTime || evento.start?.date;
  if (!inicio) return 'fecha desconocida';
  return new Date(inicio).toLocaleDateString('es-MX', {
    timeZone: 'America/Matamoros',
    weekday: 'long', year: 'numeric', month: 'long',
    day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true
  });
}

// ─── CALENDLY LINK ─────────────────────────────────────────────────
function agendaLink(c, srv) {
  const params = new URLSearchParams();
  if (c.nombre) params.set('name', c.nombre);
  if (c.correo) params.set('email', c.correo);
  if (srv)      params.set('a1', srv);
  return AGENDA_BASE + '?' + params.toString();
}

// ─── WHATSAPP ──────────────────────────────────────────────────────
async function sendText(to, text) {
  try {
    await axios.post(
      'https://graph.facebook.com/v18.0/' + PHONE_NUMBER_ID + '/messages',
      { messaging_product:'whatsapp', to, type:'text', text:{ body: text } },
      { headers:{ Authorization:'Bearer ' + WHATSAPP_TOKEN, 'Content-Type':'application/json' } }
    );
  } catch(e) { console.error('sendText:', e.response?.data || e.message); }
}

async function sendList(to, bodyText, items) {
  try {
    await axios.post(
      'https://graph.facebook.com/v18.0/' + PHONE_NUMBER_ID + '/messages',
      {
        messaging_product: 'whatsapp', to, type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: bodyText },
          action: {
            button: 'Ver servicios 💆‍♀️',
            sections: [{
              title: 'Servicios disponibles',
              rows: items.map((item, i) => ({
                id: 'srv_' + i,
                title: item.slice(0, 24),
                description: 'Selecciona para agendar'
              }))
            }]
          }
        }
      },
      { headers:{ Authorization:'Bearer ' + WHATSAPP_TOKEN, 'Content-Type':'application/json' } }
    );
  } catch(e) {
    console.error('sendList error:', e.response?.data || e.message);
    await sendText(to, bodyText + '\n\n' + items.map((s,i) => (i+1)+'. '+s).join('\n'));
  }
}

async function sendButtons(to, bodyText, buttons) {
  try {
    await axios.post(
      'https://graph.facebook.com/v18.0/' + PHONE_NUMBER_ID + '/messages',
      {
        messaging_product: 'whatsapp', to, type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: bodyText },
          action: {
            buttons: buttons.map((b, i) => ({
              type: 'reply',
              reply: { id: 'btn_' + i, title: String(b).slice(0, 20) }
            }))
          }
        }
      },
      { headers:{ Authorization:'Bearer ' + WHATSAPP_TOKEN, 'Content-Type':'application/json' } }
    );
  } catch(e) {
    await sendText(to, bodyText + '\n\n' + buttons.map((b,i) => (i+1)+'. '+b).join('\n'));
  }
}

// ─── DETECCION ─────────────────────────────────────────────────────
function detSrv(t) {
  const s = t.toLowerCase();
  if (s.includes('botox') || s.includes('toxina'))   return SERVICIOS[0];
  if (s.includes('relleno') || s.includes('hialur')) return SERVICIOS[1];
  if (s.includes('limpieza'))                        return SERVICIOS[2];
  if (s.includes('laser') || s.includes('láser'))    return SERVICIOS[3];
  if (s.includes('mesoterapia'))                     return SERVICIOS[4];
  if (/\b1\b/.test(s)) return SERVICIOS[0];
  if (/\b2\b/.test(s)) return SERVICIOS[1];
  if (/\b3\b/.test(s)) return SERVICIOS[2];
  if (/\b4\b/.test(s)) return SERVICIOS[3];
  if (/\b5\b/.test(s)) return SERVICIOS[4];
  return null;
}

function esValidoEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function esPreguntaCita(t) {
  const s = t.toLowerCase();
  return (s.includes('cuando') || s.includes('cuándo') || s.includes('que dia') || s.includes('mi cita')) &&
         (s.includes('cita') || s.includes('reserv') || s.includes('agendar'));
}

function esSi(t) {
  return t.includes('si') || t.includes('sí') || t.includes('yes') || t.includes('correcto') || t.includes('exacto');
}

function esNo(t) {
  return t.includes('no') || t.includes('corregir') || t.includes('mal') || t.includes('error');
}

// ─── FLUJO ─────────────────────────────────────────────────────────
async function handle(phone, texto) {
  const c = await getCliente(phone);
  const t = (texto || '').toLowerCase().trim();
  console.log('[' + phone + '] (' + c.estado + '): ' + texto);

  // CONSULTA DE CITA — muestra botones para actuar
  if (c.nombre && esPreguntaCita(t)) {
    const cita = await getCitaActivaGoogle(c.nombre);
    if (cita) {
      const fecha = formatFecha(cita);
      c.estado = E.CA;
      await sendButtons(phone,
        'Tu proxima cita con la Dra. Rosina es el *' + fecha + '* 📅\n\n¿Que quieres hacer?',
        ['🔄 Cancelar y reagendar', '✅ Ok, gracias']
      );
    } else {
      await sendText(phone, 'No encontre citas proximas, ' + c.nombre + '. ¿Quieres agendar una? 😊');
    }
    return;
  }

  // INICIO
  if (c.estado === E.I) {
    if (c.nombre && c.correo) {
      c.estado = E.S;
      await sendList(phone, '¡Hola de nuevo, ' + c.nombre + '! Que gusto saludarte 😊 ¿En que te podemos ayudar hoy?', SERVICIOS);
    } else if (c.nombre && !c.correo) {
      c.estado = E.C;
      await sendText(phone, '¡Hola ' + c.nombre + '! Para completar tu registro necesito tu correo electronico, ¿me lo compartes?');
    } else {
      c.estado = E.N;
      await sendText(phone,
        '¡Hola! Bienvenida al Consultorio de la Dra. Rosina 💐\n\n' +
        'Soy Bon, su asistente. Estoy aqui para ayudarte a agendar tu cita de manera rapida y sencilla 😊\n\n' +
        '¿Me regalas tu nombre completo para empezar?'
      );
    }
    return;
  }

  // NOMBRE
  if (c.estado === E.N) {
    const m = texto.match(/\b(\w{2,})\s+(\w{2,})\b/);
    if (m) {
      c.nombreTemp = capitalizarNombre(m[1] + ' ' + m[2]);
      c.estado = E.CN;
      await sendButtons(phone, '¿Tu nombre es *' + c.nombreTemp + '*? ✍️', ['✅ Si, es correcto', '❌ Corregir']);
    } else {
      await sendText(phone, 'Necesito tu nombre y apellido completos. ¿Me los regalas?');
    }
    return;
  }

  // CONFIRMAR NOMBRE
  if (c.estado === E.CN) {
    if (esSi(t)) {
      c.nombre = c.nombreTemp;
      c.nombreTemp = null;
      c.estado = E.C;
      await sendText(phone, '¡Perfecto! Ahora necesito tu correo electronico para confirmar tu cita 📧 ¿Me lo compartes?');
    } else if (esNo(t)) {
      c.nombreTemp = null;
      c.estado = E.N;
      await sendText(phone, 'Sin problema, ¿me vuelves a decir tu nombre y apellido?');
    } else {
      await sendButtons(phone, '¿Tu nombre es *' + c.nombreTemp + '*?', ['✅ Si, es correcto', '❌ Corregir']);
    }
    return;
  }

  // CORREO
  if (c.estado === E.C) {
    const emailLimpio = texto.trim().toLowerCase();
    if (esValidoEmail(emailLimpio)) {
      c.correoTemp = emailLimpio;
      c.estado = E.CC;
      await sendButtons(phone, '¿Tu correo es *' + c.correoTemp + '*? 📧', ['✅ Si, es correcto', '❌ Corregir']);
    } else {
      await sendText(phone, 'Ese correo no parece valido 😊 ¿Me lo escribes de nuevo? Ejemplo: nombre@gmail.com');
    }
    return;
  }

  // CONFIRMAR CORREO
  if (c.estado === E.CC) {
    if (esSi(t)) {
      c.correo = c.correoTemp;
      c.correoTemp = null;
      await guardarCliente(c);
      c.estado = E.S;
      await sendList(phone, '¡Listo, ' + c.nombre + '! Ya tengo todos tus datos 🎉 ¿Que servicio te interesa hoy?', SERVICIOS);
    } else if (esNo(t)) {
      c.correoTemp = null;
      c.estado = E.C;
      await sendText(phone, 'Sin problema, ¿me vuelves a escribir tu correo electronico?');
    } else {
      await sendButtons(phone, '¿Tu correo es *' + c.correoTemp + '*?', ['✅ Si, es correcto', '❌ Corregir']);
    }
    return;
  }

  // SERVICIO
  if (c.estado === E.S) {
    if (t.includes('servicios') || t.includes('ver')) {
      await sendList(phone, 'Estos son nuestros servicios:', SERVICIOS);
      return;
    }
    const srv = detSrv(texto);
    if (srv) {
      c.srvPendiente = srv;
      c.estado = E.CF;
      await sendButtons(phone, '¿Te agendo una cita de *' + srv + '*, ' + c.nombre + '? 💆‍♀️', ['✅ Si, agendame', '❌ Ver otros servicios']);
    } else {
      await sendList(phone, '¿Cual servicio te interesa, ' + c.nombre + '?', SERVICIOS);
    }
    return;
  }

  // CONFIRMACION SERVICIO
  if (c.estado === E.CF) {
    if (esNo(t) || t.includes('ver otros') || t.includes('otros')) {
      c.estado = E.S;
      c.srvPendiente = null;
      await sendList(phone, '¡Claro! ¿Cual servicio prefieres?', SERVICIOS);
      return;
    }
    if (esSi(t) || t.includes('agend')) {
      const citaActiva = await getCitaActivaGoogle(c.nombre);
      if (citaActiva) {
        c.estado = E.CA;
        const fecha = formatFecha(citaActiva);
        await sendButtons(phone,
          'Ya tienes una cita agendada el *' + fecha + '* 📅\n\n¿Que quieres hacer?',
          ['🔄 Cancelar y reagendar', '✅ Dejar asi']
        );
      } else {
        c.ultimoSrv = c.srvPendiente;
        await guardarCliente(c);
        c.estado = E.L;
        const link = agendaLink(c, c.srvPendiente);
        await sendText(phone,
          '¡Perfecto! Pica el enlace y elige el dia y hora que mejor te quede:\n\n📅 ' + link + '\n\nTu nombre, correo y servicio ya vienen llenados 😊'
        );
        c.srvPendiente = null;
      }
      return;
    }
    await sendButtons(phone, '¿Te agendo la cita de *' + c.srvPendiente + '*?', ['✅ Si, agendame', '❌ Ver otros servicios']);
    return;
  }

  // CANCELACION — busca la cita de nuevo en Google Calendar
  if (c.estado === E.CA) {
    if (esSi(t) || t.includes('cancel') || t.includes('reagend')) {
      const cita = await getCitaActivaGoogle(c.nombre);
      if (cita) {
        const ok = await cancelarCitaGoogle(cita.id);
        if (ok) {
          c.estado = E.S;
          await sendList(phone,
            'Listo, cancele tu cita ✅ ¿Que servicio quieres agendar ahora?',
            SERVICIOS
          );
        } else {
          c.estado = E.L;
          await sendText(phone, 'Hubo un problema al cancelar tu cita 😔 Por favor contacta directamente al consultorio.');
        }
      } else {
        c.estado = E.L;
        await sendText(phone, 'No encontre ninguna cita activa para cancelar 😊');
      }
      return;
    }

    if (esNo(t) || t.includes('dejar') || t.includes('asi') || t.includes('gracias')) {
      c.estado = E.L;
      await sendText(phone, '¡Perfecto, tu cita sigue igual! 😊 ¿En que mas te puedo ayudar?');
      return;
    }

    await sendButtons(phone, '¿Que quieres hacer con tu cita?', ['🔄 Cancelar y reagendar', '✅ Ok, gracias']);
    return;
  }

  // LIBRE
  if (c.estado === E.L) {
    if (t.includes('agendar') || t.includes('reservar') || t.includes('nueva cita') || t.includes('otro servicio')) {
      c.estado = E.S;
      await sendList(phone, '¡Claro! ¿Que servicio quieres esta vez?', SERVICIOS);
      return;
    }
    if (t.includes('gracias') || t.includes('listo') || t.includes('ya agende') || t.includes('ya lo hice')) {
      await sendText(phone, '¡Perfecto, ' + c.nombre + '! Te esperamos con gusto en el consultorio 😊💐 Cualquier cosa aqui estoy.');
      programarRetoque(phone);
      return;
    }
    try {
      const ctx = c.ultimoSrv ? 'Ultimo servicio de interes: ' + c.ultimoSrv + '.' : '';
      const r = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          system: SYS + '\nCliente: ' + c.nombre + '. ' + ctx,
          messages: [{ role:'user', content: texto }]
        },
        { headers:{ 'x-api-key': ANTHROPIC_KEY, 'anthropic-version':'2023-06-01', 'Content-Type':'application/json' } }
      );
      await sendText(phone, r.data.content.map(b => b.text || '').join(''));
    } catch(e) {
      await sendText(phone, '¿En que te puedo ayudar, ' + c.nombre + '? 😊');
    }
    return;
  }

  c.estado = E.I;
  await handle(phone, texto);
}

// ─── RETOQUE A 5 MESES ─────────────────────────────────────────────
function programarRetoque(phone) {
  const c = sesiones[phone];
  if (!c || c.retSet) return;
  c.retSet = true;
  const prueba = process.env.NODE_ENV !== 'production';
  const ms = prueba ? 5 * 60 * 1000 : 5 * 30 * 24 * 60 * 60 * 1000;
  setTimeout(async () => {
    const rel = (RELACIONADOS[c.ultimoSrv] || []).map(s => '- ' + s).join('\n');
    const link = agendaLink(c, c.ultimoSrv);
    await sendText(phone,
      '¡Hola ' + c.nombre + '! Han pasado 5 meses desde tu ' + c.ultimoSrv + ' con la Dra. Rosina. ¡Ya es tiempo de tu retoque! 💉\n\n' +
      'Tambien tenemos:\n' + rel + '\n\n' +
      'Para agendar: 📅 ' + link
    );
    c.estado = E.S;
    c.retSet = false;
  }, ms);
}

// ─── WEBHOOK ───────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.status(200).send(req.query['hub.challenge']);
  } else res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;
    const phone = msg.from;
    let texto = null;
    if (msg.type === 'text') texto = msg.text?.body;
    else if (msg.type === 'interactive') {
      texto = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title;
    }
    if (!texto) return;
    console.log(phone + ': ' + texto);
    await handle(phone, texto);
  } catch(e) { console.error('webhook:', e.message); }
});

app.get('/', (req, res) => res.json({
  status: 'ok',
  bot: 'Bon - Consultorio Dra. Rosina',
  clientes: Object.keys(sesiones).length
}));

// ─── INICIO ────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log('Bon corriendo en puerto ' + PORT));
});
