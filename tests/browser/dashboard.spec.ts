import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const password = 'pulsewatch-browser-test-only';

async function enter(page: Page, email: string) {
  await page.getByLabel('E-mail', { exact: true }).fill(email);
  await page.getByLabel('Senha', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Visão geral' })).toBeVisible();
}

async function register(page: Page, email: string) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Visão geral' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Criar conta' }).click();
  await page.getByLabel('Nome', { exact: true }).fill('Operador demo');
  await page.getByLabel('E-mail', { exact: true }).fill(email);
  await page.getByLabel('Senha', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Criar conta', exact: true }).press('Enter');
  await expect(page.getByRole('status')).toContainText('Entre com seu e-mail');
  await expect(page.getByLabel('Senha', { exact: true })).toBeFocused();
  await enter(page, email);
}

test('exibe o estado inicial, troca de período e protege o cadastro no celular', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('Content Security Policy')) errors.push(message.text());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/entrar');
  const fieldContrast = await page.getByLabel('E-mail', { exact: true }).evaluate((field) => {
    const luminance = (color: string) => color.match(/\d+/g)!.slice(0, 3)
      .map((channel) => Number(channel) / 255)
      .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
      .reduce((sum, v, index) => sum + v * [0.2126, 0.7152, 0.0722][index], 0);
    const contrast = (a: string, b: string) => {
      const colors = [luminance(a) + 0.05, luminance(b) + 0.05];
      return Math.max(...colors) / Math.min(...colors);
    };
    const input = getComputedStyle(field);
    return Math.min(contrast(input.borderTopColor, input.backgroundColor),
      contrast(input.borderTopColor, getComputedStyle(document.documentElement).backgroundColor));
  });
  expect(fieldContrast).toBeGreaterThanOrEqual(3);
  await register(page, 'mobile@example.test');
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toHaveText('Visão geral');
  const header = page.getByRole('banner');
  await expect(header.getByRole('link', { name: 'PulseWatch, visão geral' })).toHaveAttribute('href', '#/');
  await expect(header.getByText('Operador demo')).toBeVisible();
  await expect(header.getByRole('button', { name: 'Sair da conta' })).toBeVisible();
  await expect(page.locator('a[href^="#"]:not([href^="#/"])')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByText('Nenhum monitor cadastrado')).toBeVisible();
  await page.getByRole('button', { name: '7 dias' }).click();
  await expect(page.getByRole('button', { name: '7 dias' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Sem medições no período')).toBeVisible();
  const opener = page.getByRole('button', { name: 'Adicionar monitor', exact: true });
  const titleBox = (await heading.boundingBox())!;
  const buttonBox = (await opener.boundingBox())!;
  expect(buttonBox.x - titleBox.x - titleBox.width).toBeLessThan(24);
  expect(Math.abs(buttonBox.y - titleBox.y)).toBeLessThan(10);
  await opener.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Nome do monitor')).toBeFocused();
  await dialog.getByLabel('Nome do monitor').fill('Endereço interno');
  await dialog.getByLabel('URL', { exact: true }).fill('http://localhost/');
  await dialog.getByRole('button', { name: 'Adicionar monitor' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Endereços internos');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.setViewportSize({ width: 320, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  expect(errors).toEqual([]);
});

test('distingue erro de conexão de painel vazio e permite tentar novamente', async ({ page }) => {
  await page.route('**/api/dashboard?period=24h', (route) => route.abort());
  await register(page, 'conexao@example.test');
  await expect(page.getByText('Gráfico indisponível')).toBeVisible();
  await expect(page.getByText('Monitores indisponíveis')).toBeVisible();
  await expect(page.getByText('Nenhum monitor cadastrado')).toHaveCount(0);
  await page.unroute('**/api/dashboard?period=24h');
  await page.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(page.getByText('Nenhum monitor cadastrado')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('cadastra conta e monitor, verifica HTTP real, mantém dados após sair e entrar, e remove', async ({ page }) => {
  const target = process.env.PULSEWATCH_TEST_URL;
  test.skip(!target, 'Defina PULSEWATCH_TEST_URL para rodar o teste com acesso à internet.');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const email = 'demo@example.test';
  const screenshots = process.env.PULSEWATCH_SCREENSHOTS_DIR;
  if (screenshots) {
    await page.goto('/entrar');
    await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible();
    await page.screenshot({ path: join(screenshots, 'login.jpg'), type: 'jpeg', quality: 88, fullPage: true });
  }
  await register(page, email);
  await page.getByRole('button', { name: 'Adicionar monitor', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nome do monitor').fill('Site público');
  await dialog.getByLabel('URL', { exact: true }).fill(target!);
  await dialog.getByRole('button', { name: 'Adicionar monitor' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.monitor-row .status')).toHaveText('Disponível', { timeout: 15000 });
  const monitors = page.getByRole('table', { name: /^Monitores/ });
  await expect(monitors.getByRole('columnheader', { name: 'Resultado' })).toBeVisible();
  await expect(monitors.getByRole('cell', { name: /^HTTP 2\d\d$/ })).toBeVisible();
  if (screenshots) {
    await page.getByRole('button', { name: 'Dispensar mensagem' }).click();
    await page.screenshot({ path: join(screenshots, 'dashboard.jpg'), type: 'jpeg', quality: 88, fullPage: true });
  }
  await expect(page.locator('.metric-value').nth(1)).toHaveText('100%');
  const point = page.getByRole('button', { name: /latência média de \d+ ms/ });
  await point.focus();
  await expect(point).toBeFocused();
  await expect(page.locator('.chart-tooltip')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Disponibilidade ao longo do período' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(monitors.getByRole('cell', { name: /^HTTP 2\d\d$/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  if (screenshots) await page.screenshot({ path: join(screenshots, 'mobile.jpg'), type: 'jpeg', quality: 88, fullPage: true });
  await monitors.getByRole('link', { name: 'Site público' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Site público');
  const history = page.getByRole('region', { name: 'Lista de verificações' });
  await expect(history.getByText(/^HTTP 2\d\d$/)).toBeVisible();
  await expect(page.getByText('Nenhum incidente registrado no período.')).toBeVisible();
  await page.getByRole('button', { name: 'Verificar agora' }).click();
  await expect(history.getByRole('row')).toHaveCount(3, { timeout: 15000 });
  await page.reload();
  await expect(history.getByRole('row')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  if (screenshots) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: join(screenshots, 'monitor-real.jpg'), type: 'jpeg', quality: 88, fullPage: true });
  }
  await page.getByRole('link', { name: 'Voltar à visão geral' }).click();
  await expect(page.getByRole('main')).toBeFocused();
  await page.reload();
  await expect(monitors.getByRole('cell', { name: /^HTTP 2\d\d$/ })).toBeVisible();
  await page.getByRole('button', { name: 'Sair da conta' }).click();
  await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible();
  await expect(monitors).toHaveCount(0);
  await enter(page, email);
  await expect(monitors.getByRole('cell', { name: /^HTTP 2\d\d$/ })).toBeVisible();
  await page.getByRole('button', { name: 'Remover Site público' }).click();
  await dialog.getByRole('button', { name: 'Remover monitor' }).click();
  await expect(page.getByText('Nenhum monitor cadastrado')).toBeVisible();
  expect(errors).toEqual([]);
});

test('preserva o link de detalhes ao pedir login e lida com monitor ausente', async ({ page }) => {
  await register(page, 'link@example.test');
  await page.getByRole('button', { name: 'Sair da conta' }).click();
  await page.goto('/#/monitores/999');
  await expect(page).toHaveURL(/\/entrar#\/monitores\/999$/);
  await page.getByLabel('E-mail', { exact: true }).fill('link@example.test');
  await page.getByLabel('Senha', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Monitor não encontrado');
  await page.getByRole('link', { name: 'Voltar à visão geral' }).click();
  await expect(page.getByText('Nenhum monitor cadastrado')).toBeVisible();
});
