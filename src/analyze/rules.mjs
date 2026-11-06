// Deterministic classification rules. No heuristics beyond what is listed here, so the same
// input always produces the same plan and every decision can be explained to the user.

export const SOURCE_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
export const ASSET_RE = /\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp3|mp4|webm|html|md)$/i;

export const SERVER_FRAMEWORKS = new Set(['express', 'fastify', 'koa', 'hono', '@hapi/hapi', 'restify', 'polka', '@nestjs/core', 'h3', 'connect', 'micro']);
export const SERVER_ONLY_LIBS = new Set([
  'pg', 'mysql', 'mysql2', 'mongodb', 'mongoose', 'redis', 'ioredis', 'better-sqlite3', 'sqlite3', 'prisma', '@prisma/client',
  'knex', 'sequelize', 'typeorm', 'nodemailer', 'stripe', 'dotenv', 'bcrypt', 'bcryptjs', 'argon2', 'jsonwebtoken',
  'cors', 'helmet', 'morgan', 'multer', 'cookie-parser', 'body-parser', 'express-session', 'passport',
]);
export const NODE_ONLY_BUILTINS = new Set([
  'fs', 'fs/promises', 'child_process', 'net', 'tls', 'http', 'https', 'http2', 'cluster', 'worker_threads', 'dns', 'os', 'readline',
]);
export const CRYPTO_LIBS = new Set([
  'jose', 'tweetnacl', 'crypto', '@noble/curves', '@noble/hashes', '@noble/ed25519', '@noble/secp256k1', 'crypto-js',
  'secp256k1', 'elliptic', 'node-forge', 'otplib', 'speakeasy', 'passport-jwt',
]);
export const BROWSER_LIBS = new Set(['react', 'react-dom', 'vue', 'svelte', 'preact', 'solid-js', '@angular/core', 'lit', 'alpinejs', 'react-router-dom', 'three']);
export const SECRET_ENV_RE = /SECRET|PRIVATE|TOKEN|PASSWORD|PASSWD|API_?KEY|MNEMONIC|SEED|DATABASE_URL|DB_|CREDENTIAL/i;
export const SERVERISH_DIRS = new Set(['server', 'backend']);

export const BROWSER_GLOBALS_RE = /\b(?:document|window|localStorage|sessionStorage|navigator|location)\s*[.[]/;

export function packageName(spec) {
  const s = spec.replace(/^node:/, '');
  if (s.startsWith('@')) return s.split('/').slice(0, 2).join('/');
  return s.split('/')[0];
}
export const isBare = (spec) => !spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('#');
export const isNodeBuiltin = (spec) => spec.startsWith('node:') || NODE_ONLY_BUILTINS.has(spec) || ['path', 'crypto', 'util', 'events', 'stream', 'zlib', 'url', 'buffer', 'assert', 'process'].includes(spec);

/** Tiny glob: ** crosses directories, * does not, ? is one char. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
export const matchesAny = (file, globs = []) => globs.some((g) => globToRegExp(g.replace(/\/$/, '/**')).test(file));
