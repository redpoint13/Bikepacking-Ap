import { beforeEach, describe, expect, it, vi } from 'vitest';
import { closeWaypointEditorModal, openWaypointEditorModal } from '../ui/waypointEditorModal.js';

function makeSampleRoute() {
  return {
    name: 'Test Route',
    totalDistanceMiles: 50,
    trackPoints: [
      [34.0, -118.0],
      [34.1, -118.0],
      [34.2, -118.0],
    ],
    waypoints: [
      {
        id: 'w-1',
        name: 'Existing Spring',
        type: 'water',
        distanceFromStartMi: 10.0,
        source: 'osm',
      },
      {
        id: 'w-2',
        name: 'Existing Camp',
        type: 'camping',
        distanceFromStartMi: 25.0,
        source: 'osm',
      },
    ],
  };
}

describe('Custom Waypoint Editor Logic', () => {
  let route;

  beforeEach(() => {
    route = makeSampleRoute();
    closeWaypointEditorModal();
  });

  it('inserts a new custom user waypoint into route waypoints', () => {
    const newWpt = {
      id: 'user-12345',
      name: 'Stealth Pine Camp',
      type: 'camping',
      lat: 34.15,
      lon: -118.0,
      distanceFromStartMi: 18.5,
      description: 'Flat pine needles under trees',
      reliability: 'reliable',
      source: 'user',
      waterAvailable: 'none',
      fee: 'Free',
    };

    route.waypoints.push(newWpt);
    route.waypoints.sort((a, b) => a.distanceFromStartMi - b.distanceFromStartMi);

    expect(route.waypoints.length).toBe(3);
    expect(route.waypoints[1].name).toBe('Stealth Pine Camp');
    expect(route.waypoints[1].distanceFromStartMi).toBe(18.5);
    expect(route.waypoints[1].waterAvailable).toBe('none');
    expect(route.waypoints[1].fee).toBe('Free');
  });

  it('updates an existing custom waypoint in-place with water and fee', () => {
    const customWpt = {
      id: 'user-999',
      name: 'Goose Creek CG',
      type: 'camping',
      distanceFromStartMi: 15.0,
      source: 'user',
    };
    route.waypoints.push(customWpt);

    // Update it
    const updated = {
      ...customWpt,
      name: 'Goose Creek Campground',
      waterAvailable: 'potable',
      waterDetails: 'Potable water available (hand pump)',
      fee: '$27/night',
      reliability: 'reliable',
    };

    const idx = route.waypoints.findIndex((w) => w.id === updated.id);
    expect(idx).toBeGreaterThanOrEqual(0);
    route.waypoints[idx] = updated;

    expect(route.waypoints[idx].name).toBe('Goose Creek Campground');
    expect(route.waypoints[idx].waterAvailable).toBe('potable');
    expect(route.waypoints[idx].fee).toBe('$27/night');
  });

  it('deletes a custom waypoint correctly', () => {
    const customWpt = {
      id: 'user-to-delete',
      name: 'Temporary Hazard',
      type: 'navigation',
      distanceFromStartMi: 12.0,
      source: 'user',
    };
    route.waypoints.push(customWpt);
    expect(route.waypoints.length).toBe(3);

    route.waypoints = route.waypoints.filter((w) => w.id !== 'user-to-delete');
    expect(route.waypoints.length).toBe(2);
    expect(route.waypoints.find((w) => w.id === 'user-to-delete')).toBeUndefined();
  });

  it('renders camp water and fee fields in the modal for camping waypoints and saves them', () => {
    let savedData = null;
    openWaypointEditorModal({
      waypoint: {
        id: 'user-camp-1',
        name: 'Goose Creek Campground',
        type: 'camping',
        distanceFromStartMi: 20.0,
        waterAvailable: 'potable',
        fee: '$27/night',
      },
      onSave: (res) => {
        savedData = res;
      },
    });

    const modal = document.getElementById('waypoint-editor-modal');
    expect(modal).not.toBeNull();

    const campWaterSelect = modal.querySelector('#wpt-camp-water');
    expect(campWaterSelect).not.toBeNull();
    expect(campWaterSelect.value).toBe('potable');

    const campFeeInput = modal.querySelector('#wpt-camp-fee');
    expect(campFeeInput).not.toBeNull();
    expect(campFeeInput.value).toBe('$27/night');

    // Submit form
    const form = modal.querySelector('#waypoint-form');
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    expect(savedData).not.toBeNull();
    expect(savedData.type).toBe('camping');
    expect(savedData.waterAvailable).toBe('potable');
    expect(savedData.fee).toBe('$27/night');
  });
  it('interpolates GPS coordinates along track points when adding a waypoint', () => {
    let savedData = null;
    openWaypointEditorModal({
      route: {
        totalDistanceMiles: 50,
        trackPoints: [
          [34.0, -118.0],
          [34.5, -118.5],
          [35.0, -119.0],
        ],
      },
      defaultMile: 25.0,
      onSave: (res) => {
        savedData = res;
      },
    });

    const modal = document.getElementById('waypoint-editor-modal');
    expect(modal).not.toBeNull();

    const nameInput = modal.querySelector('#wpt-name');
    nameInput.value = 'Midway Viewpoint';

    const form = modal.querySelector('#waypoint-form');
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    expect(savedData).not.toBeNull();
    expect(savedData.name).toBe('Midway Viewpoint');
    expect(savedData.lat).toBeGreaterThan(34.0);
    expect(savedData.lon).toBeLessThan(-118.0);
  });
});
