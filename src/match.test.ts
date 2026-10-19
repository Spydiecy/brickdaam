// Run with: npm test
// Checks the "genuine LEGO only" rules against real product titles seen on the tracked stores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTitle, isBundle, isLego } from './match.js';

// [brand reported by the store, title, should it be tracked?]
const genuine: [string | null, string][] = [
  // Real sets whose names contain words an over-broad filter would trip on
  [null, 'LEGO Star Wars The Clone Wars Darth Maul Mech Building Toy for Kids 75411'],
  ['LEGO', 'Star Wars Clone Shock Trooper Mech Toy Building Set - Posable Figure for Action Play - 75448'],
  ['LEGO', 'NINJAGO Ninja Character Display 15th Anniversary - 8 Minifigures Display Stand - 71866'],
  ['LEGO', 'Star Wars Clone Trooper Battle Pack 7913'],
  ['LEGO', 'Creator 3in1 Space Shuttle - rebuild into 3 alternative models, showcase on shelf'],
  ['LEGO', 'Icons Hubble Space Telescope - Science Decor Building Set for Adults - Replica with Posable Solar Arrays 11382'],
  // Ordinary genuine listings
  ['LEGO', 'LEGO City Rides – Police Truck Toy Building Set 60481'],
  ['LEGO®', 'Technic Bugatti Bolide 42151'],
  ['Lego', 'Super Heroes Harley Quinn Minifigure Keyring 854238'],
  [null, 'LEGO Speed Champions Ferrari SF-24 F1 Race Car Driver Set 275 pieces- 77242'],
  [null, 'Sponsored Ad - LEGO DUPLO Discovery Forest with Wild Animals'],
];

const notGenuine: [string | null, string][] = [
  ['Generic', 'Building Blocks Set Compatible with LEGO Star Wars Millennium Falcon 75192'],
  ['LEGO', 'Building Blocks Compatible with Lego Technic Bugatti 42151'],
  [null, 'LEGO Compatible Brick Set 1000 pcs'],
  [null, 'Lego-compatible building bricks 1000 pcs'],
  ['Lightailing', 'Light Kit for LEGO Star Wars Millennium Falcon 75192'],
  [null, 'LED Lighting Kit for Lego 75192 Millennium Falcon'],
  ['Wonder Display', 'Acrylic Display Case for LEGO 75192'],
  ['Mould King', 'Mould King Technic Building Blocks Super Car 13145'],
  ['Nesta Toys', 'NESTA TOYS Wooden City Building Blocks Set (115 Pieces)'],
  ['Thinkerplace', 'Thinkerplace DIY Transformers Bumblebee Racing Pull Back'],
  [null, 'Pencil sharpener shaped like a Lego brick'],
  [null, 'Building toy similar to lego 500 pieces'],
  ['Lego Style Co', 'Lego-like building blocks 900 pcs'],
  ['Brickology', 'Brickology Dust Cover for LEGO Titanic 10294'],
];

test('genuine LEGO products are kept', () => {
  for (const [brand, title] of genuine) assert.equal(isLego({ brand, title }), true, title);
});

test('other brands, compatible bricks and accessories are rejected', () => {
  for (const [brand, title] of notGenuine) assert.equal(isLego({ brand, title }), false, title);
});

test('store clutter is removed from titles', () => {
  assert.equal(cleanTitle('ǀ Disney Simba The Lion King Cub 43243'), 'Disney Simba The Lion King Cub 43243');
  assert.equal(cleanTitle('Sponsored Ad - DUPLO® Discovery Forest'), 'DUPLO® Discovery Forest');
  assert.equal(cleanTitle('Star Wars Jedi amp; Clone Troopers'), 'Star Wars Jedi & Clone Troopers');
  assert.equal(cleanTitle('Jedi &amp; Clones'), 'Jedi & Clones');
});

test('multi-set bundles are told apart from single sets', () => {
  for (const t of [
    'F1 Collectibtle Set - Combo of 2 Cars Ferrari SF-24 F1 Race Car Driver Set 77242',
    'LEGO City Police Bundle 60312 and 60317',
    'LEGO Speed Champions Pack of 3 Race Cars',
    'F1 Collectibtle Set - Combo of 10 Cars Williams Racing FW46 F1 Race Car',
  ]) assert.equal(isBundle(t), true, t);
  for (const t of [
    'LEGO Creator 3-in-1 Red Dragon Animal Toy Set 31145 (149 Pieces)',
    'LEGO Creator 3in1 Space Shuttle (144 Blocks) Model Building Kit',
    'Mercedes-AMG F1 W14 E Performance Pull-Back 42165, 240 Pieces - Pack of 1',
    'LEGO Speed Champions 2 Fast 2 Furious Nissan Skyline GT-R (R34) 76917',
    'LEGO Technic 2 in 1 Mack LR Electric Garbage Truck 42167',
    'LEGO Mini Ninja Combo Mech 30699',
    'LEGO NINJAGO Ninja Team Combo Vehicle 4-in-1 Toy 71820',
    'LEGO City Combo Race Pack 60395 Building Toy Set (362 Pieces)',
    '75357 Star Wars Ghost & Phantom II Set of 2 Ahsoka Vehicles',
  ]) assert.equal(isBundle(t), false, t);
});
