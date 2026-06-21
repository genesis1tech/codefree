import { expect, test } from "bun:test"
import { CLICK_CREDIT, IMPRESSION_CREDIT } from "../src/context/wallet"

test("IMPRESSION_CREDIT equals 4 (standardized view economics, not 1)", () => {
  expect(IMPRESSION_CREDIT).toBe(4)
})

test("CLICK_CREDIT equals 100 (standardized click economics, not 5)", () => {
  expect(CLICK_CREDIT).toBe(100)
})

test("credit economics satisfy the 1 credit = $0.01 invariant", () => {
  // 4 credits = $0.04 per view, 100 credits = $1.00 per click.
  expect(IMPRESSION_CREDIT * 0.01).toBe(0.04)
  expect(CLICK_CREDIT * 0.01).toBe(1.0)
})
