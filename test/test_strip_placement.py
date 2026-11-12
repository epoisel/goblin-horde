"""Where the goblin strip lands: a saved spot must show on a real display, or the strip docks again.

Headless: the displays are plain work-area tuples, and ``place()`` runs on a stand-in strip."""

import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import desktop_platform
from desktop_platform import rect_is_visible
from goblin_strip import GoblinStrip

PRIMARY = (0, 0, 1920, 1080)
RIGHT_LOWER = (1920, 400, 3840, 1480)  # An L: the second display sits lower, leaving a void above it.
LEFT = (-1920, 0, 0, 1080)
WIDTH, HEIGHT = 400, 100


def strip_rect(right, bottom, width=WIDTH, height=HEIGHT):
    return (right - width, bottom - height, right, bottom)


class StripVisibilityTests(unittest.TestCase):
    def test_strip_fully_on_the_primary_display_is_visible(self):
        self.assertTrue(rect_is_visible(strip_rect(1900, 1070), [PRIMARY]))

    def test_strip_in_the_void_above_a_lower_second_display_is_not_visible(self):
        self.assertFalse(rect_is_visible(strip_rect(2400, 300), [PRIMARY, RIGHT_LOWER]))

    def test_same_strip_moved_down_onto_the_lower_second_display_is_visible(self):
        self.assertTrue(rect_is_visible(strip_rect(2400, 900), [PRIMARY, RIGHT_LOWER]))

    def test_strip_on_a_display_left_of_the_primary_is_visible(self):
        self.assertTrue(rect_is_visible(strip_rect(-100, 1000), [LEFT, PRIMARY]))

    def test_strip_left_of_the_primary_is_not_visible_once_that_display_is_gone(self):
        self.assertFalse(rect_is_visible(strip_rect(-100, 1000), [PRIMARY]))

    def test_less_than_40_by_20_pixels_on_a_display_is_not_visible(self):
        self.assertFalse(rect_is_visible(strip_rect(39 + WIDTH, 1000), [(WIDTH, 0, 1920, 1080)]))
        self.assertFalse(rect_is_visible(strip_rect(1000, 19 + HEIGHT), [(0, HEIGHT, 1920, 1080)]))

    def test_40_by_20_pixels_on_a_display_is_visible(self):
        self.assertTrue(rect_is_visible(strip_rect(40 + WIDTH, 20 + HEIGHT), [(WIDTH, HEIGHT, 1920, 1080)]))

    def test_strip_straddling_two_side_by_side_displays_is_visible(self):
        self.assertTrue(rect_is_visible(strip_rect(2100, 1000), [PRIMARY, (1920, 0, 3840, 1080)]))

    def test_unreadable_displays_trust_the_saved_position(self):
        self.assertTrue(rect_is_visible(strip_rect(9000, 9000), []))


class StripPlaceTests(unittest.TestCase):
    DOCK = (1904, 1074)

    def place(self, anchor, areas):
        strip = SimpleNamespace(size=(WIDTH, HEIGHT), anchor=anchor, window=MagicMock(),
                                default_anchor=lambda: self.DOCK)
        with patch.object(desktop_platform, "monitor_areas", return_value=areas):
            GoblinStrip.place(strip)
        return strip.window.geometry.call_args.args[0]

    def test_place_docks_again_when_the_saved_spot_is_in_the_void_of_an_l_layout(self):
        self.assertEqual(self.place((2400, 300), [PRIMARY, RIGHT_LOWER]), f"{WIDTH}x{HEIGHT}+1504+974")

    def test_place_keeps_a_saved_spot_on_the_lower_second_display(self):
        self.assertEqual(self.place((2400, 900), [PRIMARY, RIGHT_LOWER]), f"{WIDTH}x{HEIGHT}+2000+800")

    def test_place_keeps_a_saved_spot_left_of_the_primary(self):
        self.assertEqual(self.place((-100, 1000), [LEFT, PRIMARY]), f"{WIDTH}x{HEIGHT}+-500+900")

    def test_place_trusts_the_saved_spot_when_displays_cannot_be_read(self):
        self.assertEqual(self.place((2400, 300), []), f"{WIDTH}x{HEIGHT}+2000+200")


if __name__ == "__main__":
    unittest.main()
