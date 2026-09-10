import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { nextMenuIndex } from '../src/menu.ts'

describe('nextMenuIndex', () => {
  test('ArrowDown moves to the next item', () => {
    assert.equal(nextMenuIndex(0, 'ArrowDown', 3), 1)
  })

  test('ArrowDown wraps from the last item back to the first', () => {
    assert.equal(nextMenuIndex(2, 'ArrowDown', 3), 0)
  })

  test('ArrowUp moves to the previous item', () => {
    assert.equal(nextMenuIndex(1, 'ArrowUp', 3), 0)
  })

  test('ArrowUp wraps from the first item back to the last', () => {
    assert.equal(nextMenuIndex(0, 'ArrowUp', 3), 2)
  })

  test('Home always jumps to the first item', () => {
    assert.equal(nextMenuIndex(2, 'Home', 3), 0)
  })

  test('End always jumps to the last item', () => {
    assert.equal(nextMenuIndex(0, 'End', 3), 2)
  })

  test('with no item focused, ArrowDown starts at the first item', () => {
    assert.equal(nextMenuIndex(-1, 'ArrowDown', 3), 0)
  })

  test('with no item focused, ArrowUp starts at the last item', () => {
    assert.equal(nextMenuIndex(-1, 'ArrowUp', 3), 2)
  })

  test('an empty menu has no valid index', () => {
    assert.equal(nextMenuIndex(-1, 'ArrowDown', 0), -1)
  })
})
