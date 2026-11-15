// Uso: node tools-hash.mjs NOVA_SENHA   → imprime o hash para colar em ADMIN_HASH (js/formconfig.js)
import { hashPassword } from './js/formconfig.js';
console.log(hashPassword(process.argv[2] || ''));
