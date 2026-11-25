import { readFileSync } from 'node:fs';
import { createAuth, registration } from './auth.ts';
import { claimLegacy, openDatabase } from './database.ts';
import { authSettings, databasePath } from './settings.ts';

async function accountCommand() {
  const [, , action, ...values] = process.argv;
  if (!((action === 'create' && values.length === 2) || (action === 'claim-legacy' && values.length === 1))) {
    throw new Error('Use account -- create "Nome" e-mail ou account -- claim-legacy e-mail.');
  }
  const path = databasePath();
  if (path === ':memory:') throw new Error('Escolha um banco persistente para esta operação.');
  const database = openDatabase(path);
  try {
    if (action === 'claim-legacy') {
      const count = claimLegacy(database, values[0]);
      console.log(`Monitores legados transferidos: ${count}.`);
      return;
    }
    if (process.stdin.isTTY) throw new Error('Envie a senha pela entrada padrão a partir de um prompt oculto.');
    const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
    const body = registration({ name: values[0], email: values[1], password });
    if (!body) throw new Error('Informe nome, e-mail válido e senha de 12 a 128 caracteres.');
    const settings = authSettings(path, 'http://127.0.0.1:3001');
    const result = await createAuth(database, { ...settings, registrationEnabled: true }).provision(body);
    if (!database.prepare('SELECT id FROM "user" WHERE id = ? AND email = ?').get(result.user.id, body.email)) {
      throw new Error('Já existe uma conta com esse endereço.');
    }
    console.log('Conta criada.');
  } finally {
    database.close();
  }
}

void accountCommand().catch((error: unknown) => {
  console.error(error instanceof Error && error.name === 'Error' ? error.message : 'Não foi possível concluir a operação.');
  process.exitCode = 1;
});
