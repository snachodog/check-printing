'use strict';

const { Store } = require('express-session');

// SQLite-backed session store using the existing better-sqlite3 db instance.
// No additional npm packages required.
class SessionStore extends Store {
  constructor(db) {
    super();
    // Prepared once — get/set run on every request
    this.getStmt   = db.prepare('SELECT sess, expired FROM sessions WHERE sid = ?');
    this.setStmt   = db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?, ?, ?)');
    this.delStmt   = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.purgeStmt = db.prepare('DELETE FROM sessions WHERE expired < ?');
    // Purge expired sessions every 10 minutes
    setInterval(() => {
      try { this.purgeStmt.run(Date.now()); } catch (_) {}
    }, 10 * 60 * 1000).unref();
  }

  get(sid, cb) {
    try {
      const row = this.getStmt.get(sid);
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
      // cookie.maxAge is already in milliseconds
      const maxAge = (sess.cookie && sess.cookie.maxAge)
        ? sess.cookie.maxAge
        : 7 * 24 * 60 * 60 * 1000;
      const expired = Date.now() + maxAge;
      this.setStmt.run(sid, JSON.stringify(sess), expired);
      cb(null);
    } catch (e) { cb(e); }
  }

  destroy(sid, cb) {
    try {
      this.delStmt.run(sid);
      cb(null);
    } catch (e) { cb(e); }
  }

  touch(sid, sess, cb) {
    this.set(sid, sess, cb);
  }
}

module.exports = SessionStore;
