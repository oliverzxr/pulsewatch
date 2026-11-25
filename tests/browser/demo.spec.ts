import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const demoUrl = 'http://127.0.0.1:4174';

test('demo permite explorar monitores e incidentes sem API e identifica a simulação em toda a navegação', async ({ page, request }) => {
  const errors: string[] = [];
  const apiCalls: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', (entry) => {
    const url = new URL(entry.url());
    if (url.origin !== demoUrl || url.pathname.startsWith('/api/') || entry.method() !== 'GET') apiCalls.push(entry.url());
  });

  const screenshots = process.env.PULSEWATCH_SCREENSHOTS_DIR;
  const header = page.getByRole('banner');
  const banner = header.getByText('Dados demonstrativos simulados', { exact: true });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(demoUrl);
  await expect(banner).toBeVisible();
  await expect(header.getByText('Somente leitura', { exact: true })).toBeVisible();
  await expect(page.locator('a[href^="#"]:not([href^="#/"])')).toHaveCount(0);
  await expect(page.getByRole('navigation')).toHaveCount(0);
  const workspace = (await page.getByRole('main').boundingBox())!;
  const brand = (await header.getByRole('link', { name: 'PulseWatch, visão geral' }).boundingBox())!;
  expect(workspace.width).toBeLessThanOrEqual(1200);
  expect(workspace.x).toBeCloseTo((1920 - workspace.width) / 2);
  expect(brand.x).toBeCloseTo((await page.getByRole('heading', { level: 1 }).boundingBox())!.x);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.getByRole('button', { name: '7 dias' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('table', { name: /^Monitores/ }).getByRole('row')).toHaveCount(6);
  await expect(page.getByRole('button', { name: 'Adicionar monitor' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sair da conta' })).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  if (screenshots) await page.screenshot({ path: join(screenshots, 'demo-dashboard.jpg'), type: 'jpeg', quality: 89, fullPage: true });

  await page.getByRole('link', { name: 'API de pagamentos' }).click();
  await expect(page).toHaveURL(/#\/monitores\/1$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('API de pagamentos');
  await expect(page.getByRole('main')).toBeFocused();
  const incidents = page.getByRole('region', { name: 'Lista de incidentes' });
  await expect(incidents.getByRole('row')).toHaveCount(4);
  await expect(incidents.getByRole('columnheader', { name: 'Recuperação' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Lista de verificações' }).getByRole('row')).toHaveCount(101);
  await expect(page.getByRole('button', { name: 'Verificar agora' })).toHaveCount(0);
  await expect(banner).toBeVisible();
  if (screenshots) await page.screenshot({ path: join(screenshots, 'demo-monitor.jpg'), type: 'jpeg', quality: 89, fullPage: true });
  const points = page.getByRole('button', { name: /latência média de/ });
  await expect(points.first()).toHaveAttribute('tabindex', '0');
  await points.first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(points.nth(1)).toBeFocused();
  await expect(points.first()).toHaveAttribute('tabindex', '-1');

  await page.getByRole('button', { name: '24 horas' }).click();
  await expect(incidents.getByRole('row')).toHaveCount(2);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('API de pagamentos');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  if (screenshots) await page.screenshot({ path: join(screenshots, 'demo-mobile.jpg'), type: 'jpeg', quality: 89, fullPage: true });
  await page.setViewportSize({ width: 320, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await incidents.scrollIntoViewIfNeeded();
  expect((await banner.boundingBox())?.y).toBeGreaterThanOrEqual(0);
  await page.getByRole('link', { name: 'Voltar à visão geral' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Visão geral');
  await expect(page.getByRole('main')).toBeFocused();
  await page.getByRole('link', { name: 'Fila de eventos' }).click();
  await expect(page.getByText('Em andamento', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Remover|Verificar agora/ })).toHaveCount(0);
  await header.getByRole('link', { name: 'PulseWatch, visão geral' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Visão geral');
  expect(apiCalls).toEqual([]);
  expect(errors).toEqual([]);
  expect((await request.get(`${demoUrl}/api/dashboard`)).status()).toBe(404);
  expect((await request.post(`${demoUrl}/api/monitors`)).status()).toBe(404);
});
