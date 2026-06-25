/**
 * Command registry — handles instant commands without an AI call.
 * Commands are role-aware: each entry specifies which roles can use it.
 */

const backend  = require('../api/backendClient');
const session  = require('../whatsapp/session');
const logger   = require('../config/logger');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n) { return n?.toLocaleString('en-NG') ?? '—'; }
function date(d) { return d ? new Date(d).toLocaleDateString('en-NG', { day:'numeric', month:'short', year:'numeric' }) : '—'; }

function statusEmoji(status) {
  const map = {
    PENDING: '⏳', PENDING_PAYMENT: '💳', QUOTED: '📋',
    BOOKED: '📅', PAID: '✅', IN_PROGRESS: '🔧',
    COMPLETED: '✅', CANCELLED: '❌',
  };
  return map[status] ?? '•';
}

async function safeSend(sock, jid, text) {
  try { await sock.sendMessage(jid, { text }); } catch (err) {
    logger.error('[commands] safeSend failed:', err.message);
  }
}

// ─── Customer commands ────────────────────────────────────────────────────────

const customerCommands = {
  async menu(sock, jid, user) {
    const name = user?.name ?? 'there';
    await safeSend(sock, jid,
      `👋 Hi *${name}*! Welcome to Haven.\n\n` +
      `What would you like to do?\n\n` +
      `🔍 *Find a provider* — just describe what you need\n` +
      `📋 *requests* — view your active service requests\n` +
      `📅 *bookings* — view your bookings\n` +
      `🕓 *history* — completed jobs\n` +
      `👤 *profile* — your account details\n` +
      `⭐ *points* — your loyalty points balance\n` +
      `❓ *help* — full command list\n\n` +
      `_Just type what you need — e.g. "Find me a plumber in GRA"_`
    );
  },

  async requests(sock, jid, user) {
    try {
      await sock.sendPresenceUpdate('composing', jid).catch(() => {});
      const reqs = await backend.getCustomerRequests(user.profileId);
      if (!reqs.length) {
        await safeSend(sock, jid, `You have no active service requests.\n\nTell me what you need and I'll find the right person! 🙏`);
        return;
      }
      const lines = reqs.slice(0, 5).map((r, i) => {
        const booking = r.bookings?.[0];
        return (
          `${i + 1}. *${r.category}*\n` +
          `   📍 ${r.address}\n` +
          `   📅 ${date(r.preferredDate)}\n` +
          `   ${statusEmoji(r.status)} ${r.status}` +
          (booking ? `\n   🏪 ${booking.provider.businessName}` : '')
        );
      });
      await safeSend(sock, jid, `*Your Active Requests* 📋\n\n${lines.join('\n\n')}`);
    } catch (err) {
      await safeSend(sock, jid, `Sorry, I couldn't load your requests right now. Please try again. 🙏`);
    }
  },

  async bookings(sock, jid, user) {
    try {
      await sock.sendPresenceUpdate('composing', jid).catch(() => {});
      const bookings = await backend.getCustomerBookings(user.profileId);
      if (!bookings.length) {
        await safeSend(sock, jid, `You have no bookings yet.\n\nTell me what service you need and I'll find someone! 🙏`);
        return;
      }
      const lines = bookings.slice(0, 5).map((b, i) => (
        `${i + 1}. *${b.provider.businessName}*\n` +
        `   🔧 ${b.serviceRequest?.category ?? b.provider.category}\n` +
        `   💰 ₦${fmt(Number(b.amount))}\n` +
        `   📅 ${date(b.scheduledAt)}\n` +
        `   ${statusEmoji(b.status)} ${b.status}`
      ));
      await safeSend(sock, jid, `*Your Bookings* 📅\n\n${lines.join('\n\n')}`);
    } catch (err) {
      await safeSend(sock, jid, `Sorry, I couldn't load your bookings right now. 🙏`);
    }
  },

  async history(sock, jid, user) {
    try {
      await sock.sendPresenceUpdate('composing', jid).catch(() => {});
      const bookings = await backend.getCustomerBookings(user.profileId, 'COMPLETED');
      if (!bookings.length) {
        await safeSend(sock, jid, `No completed jobs yet.\n\nOnce a job is done, it'll show up here. 🙏`);
        return;
      }
      const lines = bookings.slice(0, 5).map((b, i) => (
        `${i + 1}. *${b.provider.businessName}*\n` +
        `   🔧 ${b.serviceRequest?.category}\n` +
        `   💰 ₦${fmt(Number(b.amount))}\n` +
        `   ✅ Completed ${date(b.completedAt)}`
      ));
      await safeSend(sock, jid, `*Completed Jobs* ✅\n\n${lines.join('\n\n')}`);
    } catch (err) {
      await safeSend(sock, jid, `Sorry, I couldn't load your history right now. 🙏`);
    }
  },

  async profile(sock, jid, user) {
    try {
      const p = await backend.getCustomerProfile(user.profileId);
      await safeSend(sock, jid,
        `*Your Profile* 👤\n\n` +
        `👤 Name: ${p.fullName}\n` +
        `📞 Phone: ${p.phone}\n` +
        `📍 Address: ${p.address ?? 'Not set'}\n` +
        `⭐ Points: ${fmt(p.totalPoints)}\n\n` +
        `_To update your profile, visit the Haven app._`
      );
    } catch (err) {
      await safeSend(sock, jid, `Sorry, I couldn't load your profile right now. 🙏`);
    }
  },

  async points(sock, jid, user) {
    try {
      const p = await backend.getCustomerProfile(user.profileId);
      await safeSend(sock, jid,
        `*Your Loyalty Points* ⭐\n\n` +
        `Balance: *${fmt(p.totalPoints)} points*\n\n` +
        `You earn points every time a service is completed.\n` +
        `_5,000 points = ₦1,000 airtime reward_`
      );
    } catch (err) {
      await safeSend(sock, jid, `Sorry, I couldn't load your points right now. 🙏`);
    }
  },

  async help(sock, jid) {
    await safeSend(sock, jid,
      `*Haven Customer Commands* ❓\n\n` +
      `*menu* — show the main menu\n` +
      `*requests* — your active service requests\n` +
      `*bookings* — your bookings\n` +
      `*history* — completed jobs\n` +
      `*profile* — your profile\n` +
      `*points* — loyalty points balance\n` +
      `*reset* — start a fresh conversation\n` +
      `*help* — this list\n\n` +
      `_Or just describe what you need — e.g. "I need an electrician in Wuse 2"_`
    );
  },
};

// ─── Provider commands ────────────────────────────────────────────────────────

const providerCommands = {
  async menu(sock, jid, user) {
    const name = user?.name ?? 'there';
    await safeSend(sock, jid,
      `👋 Hi *${name}*! Haven Provider Dashboard.\n\n` +
      `*jobs* — all your bookings\n` +
      `*pending* — pending jobs\n` +
      `*active* — in-progress jobs\n` +
      `*completed* — completed jobs\n` +
      `*inquiries* — customer inquiries\n` +
      `*profile* — your business profile\n` +
      `*help* — full command list\n\n` +
      `_Say "complete job [ID]" or "start job [ID]" to update job status._`
    );
  },

  async jobs(sock, jid, user, args) {
    try {
      await sock.sendPresenceUpdate('composing', jid).catch(() => {});
      const jobs = await backend.getProviderJobs(user.profileId);
      if (!jobs.length) {
        await safeSend(sock, jid, `You have no bookings yet.\n\nJobs will appear here when customers book you. 🙏`);
        return;
      }
      const lines = jobs.slice(0, 8).map((b, i) => (
        `${i + 1}. *${b.serviceRequest?.category ?? 'Service'}*\n` +
        `   👤 ${b.customer.fullName} | 📞 ${b.customer.phone}\n` +
        `   📍 ${b.serviceRequest?.address ?? '—'}\n` +
        `   📅 ${date(b.scheduledAt)}\n` +
        `   ${statusEmoji(b.status)} ${b.status}\n` +
        `   🆔 ID: \`${b.id.slice(0, 8)}\``
      ));
      await safeSend(sock, jid, `*Your Jobs* 🔧\n\n${lines.join('\n\n')}\n\n_Reply "complete job [ID]" or "start job [ID]"_`);
    } catch (err) {
      await safeSend(sock, jid, `Sorry, I couldn't load your jobs right now. 🙏`);
    }
  },

  async pending(sock, jid, user) {
    try {
      await sock.sendPresenceUpdate('composing', jid).catch(() => {});
      const jobs = await backend.getProviderJobs(user.profileId, 'PAID');
      if (!jobs.length) {
        await safeSend(sock, jid, `No paid/pending jobs right now. 🙏`);
        return;
      }
      const lines = jobs.slice(0, 5).map((b, i) => (
        `${i + 1}. *${b.serviceRequest?.category}* | ${b.customer.fullName}\n` +
        `   📅 ${date(b.scheduledAt)} | 💰 ₦${fmt(Number(b.amount))}\n` +
        `   🆔 \`${b.id.slice(0, 8)}\``
      ));
      await safeSend(sock, jid, `*Pending Jobs* ⏳\n\n${lines.join('\n\n')}\n\n_Say "start job [ID]" to mark as in progress._`);
    } catch (err) {
      await safeSend(sock, jid, `Sorry, couldn't load pending jobs. 🙏`);
    }
  },

  async profile(sock, jid, user) {
    try {
      const p = await backend.getProviderProfile(user.profileId);
      await safeSend(sock, jid,
        `*Your Business Profile* 🏪\n\n` +
        `🏪 Business: ${p.businessName}\n` +
        `👤 Owner: ${p.ownerName}\n` +
        `📞 Phone: ${p.phone}\n` +
        `🔧 Category: ${p.category}\n` +
        `📍 Location: ${p.location}\n` +
        `⭐ Rating: ${Number(p.avgRating).toFixed(1)} (${p.totalReviews} reviews)\n` +
        `👁 Profile Views: ${fmt(p.profileViews)}`
      );
    } catch (err) {
      await safeSend(sock, jid, `Sorry, couldn't load your profile. 🙏`);
    }
  },

  async inquiries(sock, jid, user) {
    try {
      await sock.sendPresenceUpdate('composing', jid).catch(() => {});
      const inqs = await backend.getProviderInquiries(user.profileId);
      if (!inqs.length) {
        await safeSend(sock, jid, `No new inquiries right now. 🙏`);
        return;
      }
      const lines = inqs.slice(0, 5).map((inq, i) => (
        `${i + 1}. *${inq.customer.fullName}* | 📞 ${inq.customer.phone}\n` +
        `   🔧 ${inq.service}\n` +
        `   "${inq.message.slice(0, 80)}${inq.message.length > 80 ? '…' : ''}"`
      ));
      await safeSend(sock, jid, `*New Inquiries* 📨\n\n${lines.join('\n\n')}\n\n_Reply on the Haven app to respond._`);
    } catch (err) {
      await safeSend(sock, jid, `Sorry, couldn't load inquiries. 🙏`);
    }
  },

  async help(sock, jid) {
    await safeSend(sock, jid,
      `*Haven Provider Commands* ❓\n\n` +
      `*menu* — main menu\n` +
      `*jobs* — all your bookings\n` +
      `*pending* — jobs awaiting start\n` +
      `*active* — in-progress jobs\n` +
      `*completed* — completed jobs\n` +
      `*inquiries* — customer inquiries\n` +
      `*profile* — your business profile\n` +
      `*reset* — restart conversation\n` +
      `*help* — this list\n\n` +
      `_"start job ABC12345" — mark a job as started_\n` +
      `_"complete job ABC12345" — mark a job as done_`
    );
  },
};

// ─── Command router ───────────────────────────────────────────────────────────

// Normalized triggers → handler keys
const CUSTOMER_TRIGGERS = {
  'menu': 'menu', 'hi': 'menu', 'hello': 'menu', 'start': 'menu',
  'requests': 'requests', 'my requests': 'requests',
  'bookings': 'bookings', 'my bookings': 'bookings', 'orders': 'bookings',
  'history': 'history', 'past jobs': 'history',
  'profile': 'profile', 'my profile': 'profile',
  'points': 'points', 'my points': 'points',
  'help': 'help',
};

const PROVIDER_TRIGGERS = {
  'menu': 'menu', 'hi': 'menu', 'hello': 'menu', 'start': 'menu',
  'jobs': 'jobs', 'my jobs': 'jobs',
  'pending': 'pending', 'pending jobs': 'pending',
  'active': 'active', 'in progress': 'active',
  'completed': 'completed', 'done': 'completed',
  'inquiries': 'inquiries', 'inbox': 'inquiries',
  'profile': 'profile', 'my profile': 'profile',
  'help': 'help',
};

const UNIVERSAL_TRIGGERS = {
  'reset': '_reset',
  'start over': '_reset',
  '/reset': '_reset',
  '/help': 'help',
  '/services': '_services',
};

/**
 * Try to dispatch a command. Returns true if handled, false if not a command.
 */
async function dispatch(sock, jid, phoneNumber, text, user) {
  const norm = text.trim().toLowerCase();
  const role = user?.role ?? null;

  // ── Universal commands ────────────────────────────────────────────────────
  if (UNIVERSAL_TRIGGERS[norm]) {
    const action = UNIVERSAL_TRIGGERS[norm];
    if (action === '_reset') {
      await session.clearSession(phoneNumber);
      await safeSend(sock, jid, `Conversation reset ✅\n\nFresh start! How can I help you? 🙏`);
      return true;
    }
    if (action === '_services') {
      await safeSend(sock, jid,
        `*Services available on Haven* 🔧\n\n` +
        `🔌 Electricians   🔧 Plumbers\n` +
        `🚗 Mechanics   🧹 Cleaners\n` +
        `❄️ Technicians   🪵 Carpenters\n` +
        `🎨 Painters   🏗️ Builders\n\n` +
        `Just describe what you need and your area!`
      );
      return true;
    }
  }

  // ── Job status shortcuts for providers ────────────────────────────────────
  if (role === 'PROVIDER') {
    const startMatch  = norm.match(/^(?:start|begin) job (.{6,})/);
    const completeMatch = norm.match(/^(?:complete|done|finish) job (.{6,})/);
    const acceptMatch = norm.match(/^accept job (.{6,})/);

    if (startMatch || acceptMatch) {
      const shortId = (startMatch ?? acceptMatch)[1].trim();
      await handleJobStart(sock, jid, user, shortId);
      return true;
    }
    if (completeMatch) {
      const shortId = completeMatch[1].trim();
      await handleJobComplete(sock, jid, user, shortId);
      return true;
    }
  }

  // ── Role-based commands ───────────────────────────────────────────────────
  if (role === 'CUSTOMER') {
    const handlerKey = CUSTOMER_TRIGGERS[norm];
    if (handlerKey && customerCommands[handlerKey]) {
      await customerCommands[handlerKey](sock, jid, user);
      return true;
    }
  }

  if (role === 'PROVIDER') {
    const handlerKey = PROVIDER_TRIGGERS[norm];
    if (handlerKey && providerCommands[handlerKey]) {
      await providerCommands[handlerKey](sock, jid, user);
      return true;
    }
  }

  // Unrecognised — route to AI
  return false;
}

// ─── Job status helpers ───────────────────────────────────────────────────────

async function handleJobStart(sock, jid, user, shortId) {
  try {
    // Find booking by short ID prefix
    const jobs = await backend.getProviderJobs(user.profileId, 'PAID');
    const job = jobs.find(j => j.id.startsWith(shortId) || j.id === shortId);
    if (!job) {
      await safeSend(sock, jid, `Couldn't find a paid job matching ID \`${shortId}\`.\n\nType *pending* to see jobs ready to start.`);
      return;
    }
    await backend.startJob(user.profileId, job.id);
    await safeSend(sock, jid,
      `✅ Job marked as *In Progress*!\n\n` +
      `🔧 ${job.serviceRequest?.category}\n` +
      `👤 ${job.customer.fullName}\n\n` +
      `When you're done, say *complete job ${shortId}*`
    );
  } catch (err) {
    await safeSend(sock, jid, `Sorry, couldn't update that job: ${err.message} 🙏`);
  }
}

async function handleJobComplete(sock, jid, user, shortId) {
  try {
    const jobs = await backend.getProviderJobs(user.profileId);
    const job = jobs.find(j =>
      (j.id.startsWith(shortId) || j.id === shortId) &&
      ['PAID', 'IN_PROGRESS'].includes(j.status)
    );
    if (!job) {
      await safeSend(sock, jid, `Couldn't find an active job matching ID \`${shortId}\`.\n\nType *jobs* to see all your bookings.`);
      return;
    }
    await backend.completeJob(user.profileId, job.id);
    await safeSend(sock, jid,
      `🎉 Job marked as *Completed*!\n\n` +
      `🔧 ${job.serviceRequest?.category}\n` +
      `👤 ${job.customer.fullName}\n` +
      `💰 ₦${job.amount?.toLocaleString('en-NG')}\n\n` +
      `The customer has been notified and points have been awarded. Great work! 🙏`
    );
  } catch (err) {
    await safeSend(sock, jid, `Sorry, couldn't complete that job: ${err.message} 🙏`);
  }
}

module.exports = { dispatch };
