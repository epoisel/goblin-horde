import unittest

from desktop_widget import BODY_LINES, TEXT_STEP, fit_text, text_window, wrap_text


class CharacterWidthFont:
    def measure(self, value):
        return len(value)


class WidgetTextTests(unittest.TestCase):
    def test_long_update_remains_available_after_first_bubble(self):
        message = "Assuming you mean Microsoft Fabric your concern is well founded Fabric now handles much more"
        lines = wrap_text(CharacterWidthFont(), message, 18)
        self.assertGreater(len(lines), BODY_LINES)
        self.assertEqual(" ".join(lines), message)

        offset = 0
        seen = set()
        while True:
            offset, visible, maximum = text_window(lines, offset)
            seen.update(range(offset, offset + len(visible)))
            if offset == maximum:
                break
            offset += TEXT_STEP
        self.assertEqual(seen, set(range(len(lines))))

    def test_text_window_clamps_manual_scroll(self):
        lines = [str(index) for index in range(7)]
        self.assertEqual(text_window(lines, -8), (0, lines[:BODY_LINES], 3))
        self.assertEqual(text_window(lines, 99), (3, lines[3:], 3))

    def test_party_name_fits_and_marks_truncation(self):
        font = CharacterWidthFont()
        self.assertEqual(fit_text(font, "API", 8), "API")
        name = "Explore a two-player roguelite"
        for width in range(1, len(name) + 4):
            value = fit_text(font, name, width)
            self.assertLessEqual(font.measure(value), width)
            self.assertTrue(value.endswith("…") if width < len(name) else value == name)


if __name__ == "__main__":
    unittest.main()
