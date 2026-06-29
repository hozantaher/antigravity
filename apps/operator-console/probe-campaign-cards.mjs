import { chromium } from '@playwright/test';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  // Navigate and wait for cards to load
  await page.goto('http://localhost:18175/campaigns/1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  
  // Check for both class names
  const statCards = await page.locator('.stat-card').count();
  const kpiCells = await page.locator('.kpi-cell').count();
  
  console.log(`stat-card elements: ${statCards}`);
  console.log(`kpi-cell elements: ${kpiCells}`);
  
  await browser.close();
})();
