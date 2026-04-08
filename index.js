const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const VERIFY_TOKEN    = process.env.VERIFY_TOKEN || 'dra-rosina-2024';
const WHATSAPP_TOKEN  = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const CALENDLY_TOKEN  = process.env.CALENDLY_TOKEN;
const PORT            = process.env.PORT || 3000;
const AGENDA_URL      = 'https://calendly.com/melissavargass16/dra-rosina';
const CALENDLY_USER   = 'https://api.calendly.com/users/87bb5c4b-e72c-4fa4-a170-56ae1fbbe967';

const clientes = {};

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

const SYS = 'Eres Bon, ayudante personal de Mely (Dra. Rosina). Responde en espanol de Mexico, tono calido y cercano. Max 3 oraciones. Nunca digas que eres IA o bot. Usa el historial del cliente naturalmente.';

const E = { I:'inicio', N:'nombre', S:'servicio', L:'libre' };

// ─── WHATSAPP ─────────────────────────────────────────────────────
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

// ─── CALENDLY ─────────────────────────────────────────────────────
async function getCitasCliente(email) {
  try {
    const res = await axios.get('https://api.calendly.com/scheduled_events', {
      headers: { Authorization: 'Bearer ' + CALENDLY_TOKEN },
      params: {
        organization: CALENDLY_USER,
        invitee_email: email,
        status: 'active',
        count: 5,
        sort: 'start_time:asc'
      }
    });
    return res.data.collection || [];
  } catch(e) {
    console.error('Calendly getCitas:', e.response?.data || e.message);
    return [];
  }
}

async function getCitasPorNombre(nombre) {
  try {
    // Busca citas activas proximas
    const ahora = new Date().toISOString();
    const res = await axios.get('https://api.calendly.com/scheduled_events', {
      headers: { Authorization: 'Bearer ' + CALENDLY_TOKEN },
      params: {
        user: CALENDLY_USER,
        status: 'active',
        min_start_time: ahora,
        count: 20,
        sort: 'start_time:asc'
      }
    });
    const eventos = res.data.collection || [];

    // Para cada evento buscar invitados y filtrar por nombre
    const citasDelCliente = [];
    for (const evento of eventos) {
      try {
        const uuid = evento.uri.split('/').pop();
        const invRes = await axios.get('https://api.calendly.com/scheduled_events/' + uuid + '/invitees', {
          headers: { Authorization: 'Bearer ' + CALENDLY_TOKEN }
        });
        const invitados = invRes.data.collection || [];
        const match = invitados.find(inv =>
          inv.name && inv.name.toLowerCase().includes(nombre.split(' ')[0].toLowerCase())
        );
        if (match) {
          citasDelCliente.push({ evento, invitado: match });
        }
      } catch(e) { /* skip */ }
    }
    return citasDelCliente;
  } catch(e) {
    console.error('Calendly getCitasPorNombre:', e.response?.data || e.message);
    return [];
  }
}

function formatFecha(isoString) {
  const fecha = new Date(isoString);
  const opciones = {
    timeZone: 'America/Matamoros',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  };
  return fecha.toLocaleDateString('es-MX', opciones);
}

// ─── FLUJO ────────────────────────────────────────────────────────
function detSrv(t) {
  const s = t.toLowerCase();
  if (s.includes('botox') || s.includes('toxina')) return SERVICIOS[0];
  if (s.includes('relleno') || s.includes('hialur')) return SERVICIOS[1];
  if (s.includes('limpieza')) return SERVICIOS[2];
  if (s.includes('laser') || s.includes('laser')) return SERVICIOS[3];
  if (s.includes('mesoterapia')) return SERVICIOS[4];
  if (s.includes('1')) return SERVICIOS[0];
  if (s.includes('2')) return SERVICIOS[1];
  if (s.includes('3')) return SERVICIOS[2];
  if (s.includes('4')) return SERVICIOS[3];
  if (s.includes('5')) return SERVICIOS[4];
  return null;
}

function esPreguntaCita(t) {
  const s = t.toLowerCase();
  return (s.includes('cuando') || s.includes('cuándo') || s.includes('que dia') || s.includes('qué día')) &&
         (s.includes('cita') || s.includes('agendar') || s.includes('reserv') || s.includes('mi cita'));
}

async function handle(phone, texto) {
  if (!clientes[phone]) {
    clientes[phone] = { phone, nombre:null, estado:E.I, ultimoSrv:null, hist:[], remSet:false, retSet:false };
  }
  const c = clientes[phone];
  const t = (texto || '').toLowerCase().trim();
  console.log('[' + phone + '] (' + c.estado + '): ' + texto);

  // CONSULTA DE CITA en cualquier estado
  if (c.nombre && esPreguntaCita(t)) {
    const citas = await getCitasPorNombre(c.nombre);
    if (citas.length > 0) {
      const { evento } = citas[0];
      const fecha = formatFecha(evento.start_time);
      await sendText(phone,
        'Tu proxima cita con Mely es el *' + fecha + '* 📅\n\n' +
        (citas.length > 1 ? 'Tienes ' + citas.length + ' citas agendadas en total.' : '') +
        '\nCualquier cambio puedes hacerlo en: ' + AGENDA_URL
      );
    } else {
      await sendText(phone,
        'No encontre citas proximas a tu nombre, ' + c.nombre + '. ' +
        'Si quieres agendar una, aqui esta el link: 📅 ' + AGENDA_URL
      );
    }
    return;
  }

  // INICIO
  if (c.estado === E.I) {
    if (c.nombre) {
      c.estado = E.S;
      await sendList(phone, 'Hola ' + c.nombre + '! Que servicio te interesa hoy?', SERVICIOS);
    } else {
      c.estado = E.N;
      await sendText(phone, 'Hola! Soy Bon. Para empezar, me dices tu nombre completo?');
    }
    return;
  }

  // NOMBRE
  if (c.estado === E.N) {
    const m = texto.match(/\b(\w{2,})\s+(\w{2,})\b/);
    if (m) {
      c.nombre = m[1] + ' ' + m[2];
      c.estado = E.S;
      await sendList(phone, 'Mucho gusto, ' + c.nombre + '! Que servicio te interesa?', SERVICIOS);
    } else {
      await sendText(phone, 'Necesito tu nombre y apellido completos. Me los dices?');
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
      c.ultimoSrv = srv;
      c.estado = E.L;
      await sendText(phone,
        'Perfecto! Para agendar tu cita de *' + srv + '*, pica el siguiente enlace y elige el dia y hora que mejor te quede:\n\n' +
        '📅 ' + AGENDA_URL + '\n\n' +
        'Ahi puedes ver todos los horarios disponibles de Mely 😊'
      );
    } else {
      await sendList(phone, 'Cual servicio te interesa, ' + c.nombre + '?', SERVICIOS);
    }
    return;
  }

  // LIBRE
  if (c.estado === E.L) {
    if (t.includes('cita') || t.includes('agendar') || t.includes('reservar')) {
      c.estado = E.S;
      await sendList(phone, 'Claro! Que servicio quieres esta vez?', SERVICIOS);
      return;
    }
    if (t.includes('gracias') || t.includes('listo') || t.includes('ya agende') || t.includes('ya lo hice')) {
      await sendText(phone, 'Perfecto, ' + c.nombre + '! Te esperamos con gusto. Cualquier cosa aqui estoy 😊💐');
      programarRetoque(phone);
      return;
    }
    // IA para preguntas libres
    try {
      const ctx = c.ultimoSrv ? 'Ultimo servicio de interes: ' + c.ultimoSrv + '.' : 'Sin historial previo.';
      const r = await axios.post(
        'https://api.anthropic.com/v1/messages',
        { model:'claude-haiku-4-5-20251001', max_tokens:200, system: SYS + '\nCliente: ' + c.nombre + '. ' + ctx, messages:[{ role:'user', content:texto }] },
        { headers:{ 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01', 'Content-Type':'application/json' } }
      );
      await sendText(phone, r.data.content.map(b => b.text || '').join(''));
    } catch(e) {
      await sendText(phone, 'Hola ' + c.nombre + '! En que te puedo ayudar? 😊');
    }
    return;
  }

  c.estado = E.I;
  await handle(phone, texto);
}

// ─── RETOQUE A 5 MESES ────────────────────────────────────────────
function programarRetoque(phone) {
  const c = clientes[phone];
  if (!c || c.retSet) return;
  c.retSet = true;
  const prueba = process.env.NODE_ENV !== 'production';
  const ms = prueba ? 5 * 60 * 1000 : 5 * 30 * 24 * 60 * 60 * 1000;
  setTimeout(async () => {
    const rel = (RELACIONADOS[c.ultimoSrv] || []).map(s => '- ' + s).join('\n');
    await sendText(phone,
      'Hola ' + c.nombre + '! Han pasado 5 meses desde tu ' + c.ultimoSrv + ' con Mely. Ya es tiempo de tu retoque! 💉\n\n' +
      'Tambien tenemos:\n' + rel + '\n\n' +
      'Para agendar: 📅 ' + AGENDA_URL
    );
    c.estado = E.S;
    c.retSet = false;
  }, ms);
}

// ─── WEBHOOK ──────────────────────────────────────────────────────
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

app.get('/', (req, res) => res.json({ status:'ok', bot:'Bon - Consultorio Dra. Rosina', clientes: Object.keys(clientes).length }));

app.listen(PORT, () => console.log('Bon corriendo en puerto ' + PORT));
