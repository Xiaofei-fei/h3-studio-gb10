// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { DisclosureSection } from '../src/components/DisclosureSection';

afterEach(() => cleanup());

it('publishes its summary and toggles the controlled content accessibly', async () => {
  const user = userEvent.setup();

  function Fixture() {
    const [open, setOpen] = useState(false);
    return (
      <DisclosureSection
        id="runtime"
        label="运行参数"
        summary="H3 Standard · 5 秒"
        open={open}
        onOpenChange={setOpen}
      >
        <p>服务选择</p>
      </DisclosureSection>
    );
  }

  render(<Fixture />);

  const trigger = screen.getByRole('button', { name: /运行参数.*H3 Standard.*5 秒/ });
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(screen.getByText('服务选择')).not.toBeVisible();

  await user.click(trigger);

  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('服务选择')).toBeVisible();
});
