import {
  expect,
  test,
  type Locator,
  type Page,
  type PageAssertionsToHaveScreenshotOptions,
} from '@playwright/test';

export const darwinBaseline = { tag: '@darwin-baseline' } as const;

export function darwinScreenshot(
  target: Page | Locator,
  name: string,
  { soft, ...options }: PageAssertionsToHaveScreenshotOptions & { soft?: boolean } = {},
) {
  if (process.platform !== 'darwin' || !test.info().tags.includes(darwinBaseline.tag))
    throw new Error('Screenshot comparisons require macOS and the @darwin-baseline test tag.');
  return expect.configure({ soft })(target).toHaveScreenshot(name, options);
}
