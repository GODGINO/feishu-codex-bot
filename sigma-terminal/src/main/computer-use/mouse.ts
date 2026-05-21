/**
 * Mouse control via nut-js.
 */

import { mouse, Point, Button, straightTo, sleep } from '@nut-tree-fork/nut-js';

// Configure mouse speed for smoother movement
mouse.config.mouseSpeed = 1500;

export async function mouseMove(x: number, y: number): Promise<{ x: number; y: number }> {
  await mouse.move(straightTo(new Point(x, y)));
  return { x, y };
}

export async function mouseClick(
  x: number,
  y: number,
  button: 'left' | 'right' | 'middle' = 'left',
  count: number = 1,
): Promise<{ clicked: { x: number; y: number; button: string; count: number } }> {
  await mouse.move(straightTo(new Point(x, y)));
  await sleep(50);

  const btn = button === 'right' ? Button.RIGHT : button === 'middle' ? Button.MIDDLE : Button.LEFT;

  if (count === 2) {
    await mouse.doubleClick(btn);
  } else {
    for (let i = 0; i < count; i++) {
      await mouse.click(btn);
      if (i < count - 1) await sleep(80);
    }
  }

  return { clicked: { x, y, button, count } };
}

export async function mouseDrag(
  from: { x: number; y: number },
  to: { x: number; y: number },
  duration: number = 500,
): Promise<{ dragged: { from: typeof from; to: typeof to } }> {
  // Move to start position
  await mouse.move(straightTo(new Point(from.x, from.y)));
  await sleep(100);

  // Press button
  await mouse.pressButton(Button.LEFT);
  await sleep(50);

  // Adjust speed based on duration
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const originalSpeed = mouse.config.mouseSpeed;
  mouse.config.mouseSpeed = Math.max(100, distance / (duration / 1000));

  try {
    await mouse.move(straightTo(new Point(to.x, to.y)));
    await sleep(50);
  } finally {
    await mouse.releaseButton(Button.LEFT);
    mouse.config.mouseSpeed = originalSpeed;
  }

  return { dragged: { from, to } };
}

export async function mouseScroll(
  x: number,
  y: number,
  dx: number,
  dy: number,
): Promise<{ scrolled: { x: number; y: number; dx: number; dy: number } }> {
  if (x !== undefined && y !== undefined) {
    await mouse.move(straightTo(new Point(x, y)));
    await sleep(50);
  }

  if (dy !== 0) {
    if (dy > 0) {
      await mouse.scrollDown(Math.abs(dy));
    } else {
      await mouse.scrollUp(Math.abs(dy));
    }
  }

  if (dx !== 0) {
    if (dx > 0) {
      await mouse.scrollRight(Math.abs(dx));
    } else {
      await mouse.scrollLeft(Math.abs(dx));
    }
  }

  return { scrolled: { x, y, dx, dy } };
}

export async function mousePosition(): Promise<{ x: number; y: number }> {
  const pos = await mouse.getPosition();
  return { x: pos.x, y: pos.y };
}
