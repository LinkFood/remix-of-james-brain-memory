import { describe, it, expect } from 'vitest';
import { parseListItems, parseTextToListItems } from './parseListItems';

describe('parseListItems', () => {
  it('returns empty array for null input', () => {
    expect(parseListItems(null)).toEqual([]);
  });

  it('returns empty array for undefined input', () => {
    expect(parseListItems(undefined)).toEqual([]);
  });

  it('returns empty array for non-array input', () => {
    expect(parseListItems('string')).toEqual([]);
    expect(parseListItems(123)).toEqual([]);
    expect(parseListItems({})).toEqual([]);
  });

  it('returns empty array for empty array', () => {
    expect(parseListItems([])).toEqual([]);
  });

  it('parses valid list items', () => {
    const input = [
      { text: 'Item 1', checked: false },
      { text: 'Item 2', checked: true },
    ];
    expect(parseListItems(input)).toEqual(input);
  });

  it('filters out invalid items', () => {
    const input = [
      { text: 'Valid', checked: false },
      { text: 123, checked: false }, // invalid text
      { text: 'Missing checked' }, // missing checked
      null,
      'string',
      { checked: true }, // missing text
      { text: 'Also Valid', checked: true },
    ];
    expect(parseListItems(input)).toEqual([
      { text: 'Valid', checked: false },
      { text: 'Also Valid', checked: true },
    ]);
  });

  it('handles items with extra properties', () => {
    const input = [
      { text: 'Item', checked: false, extra: 'ignored' },
    ];
    expect(parseListItems(input)).toEqual([
      { text: 'Item', checked: false, extra: 'ignored' },
    ]);
  });
});

describe('parseTextToListItems', () => {
  it('returns empty array for null input', () => {
    expect(parseTextToListItems(null)).toEqual([]);
  });

  it('returns empty array for undefined input', () => {
    expect(parseTextToListItems(undefined)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseTextToListItems('')).toEqual([]);
  });

  it('parses bullet points with dash', () => {
    const input = '- Item 1\n- Item 2\n- Item 3';
    expect(parseTextToListItems(input)).toEqual([
      { text: 'Item 1', checked: false },
      { text: 'Item 2', checked: false },
      { text: 'Item 3', checked: false },
    ]);
  });

  it('parses bullet points with asterisk', () => {
    const input = '* First\n* Second';
    expect(parseTextToListItems(input)).toEqual([
      { text: 'First', checked: false },
      { text: 'Second', checked: false },
    ]);
  });

  it('parses bullet points with bullet character', () => {
    const input = '• One\n• Two';
    expect(parseTextToListItems(input)).toEqual([
      { text: 'One', checked: false },
      { text: 'Two', checked: false },
    ]);
  });

  it('parses numbered lists with period', () => {
    const input = '1. First\n2. Second\n3. Third';
    expect(parseTextToListItems(input)).toEqual([
      { text: 'First', checked: false },
      { text: 'Second', checked: false },
      { text: 'Third', checked: false },
    ]);
  });

  it('parses numbered lists with parenthesis', () => {
    const input = '1) First\n2) Second';
    expect(parseTextToListItems(input)).toEqual([
      { text: 'First', checked: false },
      { text: 'Second', checked: false },
    ]);
  });

  it('parses unchecked checkbox items', () => {
    const input = '- [ ] Todo 1\n- [ ] Todo 2';
    expect(parseTextToListItems(input)).toEqual([
      { text: 'Todo 1', checked: false },
      { text: 'Todo 2', checked: false },
    ]);
  });

  it('parses checked checkbox items', () => {
    const input = '- [x] Done 1\n- [X] Done 2';
    expect(parseTextToListItems(input)).toEqual([
      { text: 'Done 1', checked: true },
      { text: 'Done 2', checked: true },
    ]);
  });

  it('parses mixed checkbox items', () => {
    const input = '- [x] Done\n- [ ] Not done\n- [X] Also done';
    expect(parseTextToListItems(input)).toEqual([
      { text: 'Done', checked: true },
      { text: 'Not done', checked: false },
      { text: 'Also done', checked: true },
    ]);
  });

  it('ignores empty lines', () => {
    const input = '- Item 1\n\n- Item 2\n\n\n- Item 3';
    expect(parseTextToListItems(input)).toEqual([
      { text: 'Item 1', checked: false },
      { text: 'Item 2', checked: false },
      { text: 'Item 3', checked: false },
    ]);
  });

  it('trims whitespace from items', () => {
    const input = '-   Spaced Item   \n-    Another   ';
    expect(parseTextToListItems(input)).toEqual([
      { text: 'Spaced Item', checked: false },
      { text: 'Another', checked: false },
    ]);
  });

  it('ignores lines that do not match list patterns', () => {
    const input = 'Just text\n- Valid item\nMore text\n1. Another valid';
    expect(parseTextToListItems(input)).toEqual([
      { text: 'Valid item', checked: false },
      { text: 'Another valid', checked: false },
    ]);
  });
});
