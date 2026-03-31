'use strict';

const nodemailer = require('nodemailer');
const db = require('../db/database');

function getSmtpSettings() {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'smtp_%'").all();
  const s = Object.fromEntries(rows.map(r => [r.key, r.value || '']));
  return {
    host:   s.smtp_host || '',
    port:   parseInt(s.smtp_port, 10) || 587,
    secure: s.smtp_secure === '1',
    user:   s.smtp_user || '',
    pass:   s.smtp_pass || '',
    from:   s.smtp_from || '',
  };
}

async function sendPasswordReset(toEmail, resetLink) {
  const s = getSmtpSettings();
  if (!s.host || !s.from) {
    throw new Error('SMTP is not configured. Ask an admin to configure email settings.');
  }
  const transporter = nodemailer.createTransport({
    host:   s.host,
    port:   s.port,
    secure: s.secure,
    auth:   s.user ? { user: s.user, pass: s.pass } : undefined,
  });
  await transporter.sendMail({
    from:    s.from,
    to:      toEmail,
    subject: 'ezcheck Password Reset',
    text:    `Click the link below to reset your password. This link expires in 1 hour.\n\n${resetLink}\n\nIf you did not request this, ignore this email.`,
    html:    `<p>Click the link below to reset your password. This link expires in 1 hour.</p><p><a href="${resetLink}">${resetLink}</a></p><p>If you did not request this, ignore this email.</p>`,
  });
}

module.exports = { getSmtpSettings, sendPasswordReset };
