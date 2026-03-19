'use strict';

const db = require('../db/database');

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

// Blocks viewers; allows admin and editor
function requireEditor(req, res, next) {
  if (!req.session || req.session.role === 'viewer') {
    return res.status(403).json({ error: 'Write access required.' });
  }
  next();
}

// Returns true if the current session user can access the given account
function canAccessAccount(session, accountId) {
  if (!session || !session.userId) return false;
  if (session.role === 'admin') return true;
  const row = db.prepare(
    'SELECT 1 FROM user_accounts WHERE user_id = ? AND account_id = ?'
  ).get(session.userId, accountId);
  return !!row;
}

// Returns true if the user has editor (write) access to the given account.
// Admins always return true. Non-admins need user_accounts.role = 'editor'.
function isEditorForAccount(session, accountId) {
  if (!session || !session.userId) return false;
  if (session.role === 'admin') return true;
  const row = db.prepare(
    "SELECT role FROM user_accounts WHERE user_id = ? AND account_id = ?"
  ).get(session.userId, accountId);
  return !!(row && row.role === 'editor');
}

// Middleware factory — resolves accountId via a callback on req, then checks access
function requireAccountAccess(getAccountId) {
  return (req, res, next) => {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }
    if (req.session.role === 'admin') return next();
    const accountId = parseInt(getAccountId(req), 10);
    if (!accountId) return next(); // route handler will deal with missing param
    if (!canAccessAccount(req.session, accountId)) {
      return res.status(403).json({ error: 'Access denied.' });
    }
    next();
  };
}

module.exports = { requireAuth, requireAdmin, requireEditor, requireAccountAccess, canAccessAccount, isEditorForAccount };
