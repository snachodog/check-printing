'use strict';

const { Store } = require('express-session');

// SQLite-backed session store using the existing better-sqlite3 db instance.
// No additional npm packages required.
class SessionStore extends Store {
  constructor(db) {
    super();
    this.db = db;
    // Purge expired sessions every 10 minutes
    setInterval(() => {
      try { db.prepare('DELETE FROM sessions WHERE expired < ?').run(Date.now()); } catch (_) {}
    }, 10 * 60 * 1000).unref();
  }

  get(sid, cb) {
    try {
      const row = this.db.prepare('SELECT sess, expired FROM sessions WHERE sid = ?').get(sid);
      if (!row) return cb(null, null);
      if (Date.now() > row.expired) {
        this.destroy(sid, () => {});
        return cb(null, null);
      }
      cb(null, JSON.parse(row.sess));
    } catch (e) { cb(e); }
  }

  set(sid, sess, cb) {
    try {
      const maxAge = (sess.cookie && sess.cookie.maxAge)
        ? sess.cookie.maxAge * 1000
        : 7 * 24 * 60 * 60 * 1000;
      const expired = Date.now() + maxAge;
      this.db.prepare(
        'INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?, ?, ?)'
      ).run(sid, JSON.stringify(sess), expired);
      cb(null);
    } catch (e) { cb(e); }
  }

  destroy(sid, cb) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb(null);
    } catch (e) { cb(e); }
  }

  touch(sid, sess, cb) {
    this.set(sid, sess, cb);
  }
}

module.exports = SessionStore;
