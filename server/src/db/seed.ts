import { db } from './index.js'
import { operators } from './schema.js'
import { hashPassword } from '../auth/password.js'
import { logger } from '../config/logger.js'

async function seed() {
  const [admin, op1, op2] = await Promise.all([
    hashPassword('admin123'),
    hashPassword('op123'),
    hashPassword('op123'),
  ])
  await db
    .insert(operators)
    .values([
      { name: 'Admin Alelo', email: 'admin@alelo.com', passwordHash: admin, role: 'admin' },
      { name: 'Operador 1', email: 'op1@alelo.com', passwordHash: op1, role: 'operator' },
      { name: 'Operador 2', email: 'op2@alelo.com', passwordHash: op2, role: 'operator' },
    ])
    .onConflictDoNothing()
  logger.info('Seed concluído. Login: admin@alelo.com / admin123')
  process.exit(0)
}

seed().catch((err) => {
  logger.error({ err }, 'Seed falhou')
  process.exit(1)
})
