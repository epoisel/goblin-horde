"""Phone access is switched from the launchpad menu: on only after a yes, off at once, via the local endpoints."""

import unittest
from concurrent.futures import Future
from unittest.mock import Mock, patch

from desktop_widget import GoblinWidget


def phone_widget(phone: dict) -> GoblinWidget:
    widget = GoblinWidget.__new__(GoblinWidget)
    widget.closing = False
    widget.root = Mock()
    widget.phone = phone
    widget.post_local = Mock()
    widget.future = Future()
    widget.executor = Mock(submit=Mock(return_value=widget.future))
    return widget


def finish(widget: GoblinWidget, result: dict) -> None:
    widget.future.set_result(result)
    widget.root.after.call_args.args[1]()


class PhoneAccessMenuTests(unittest.TestCase):
    def test_turning_on_asks_first_explains_what_a_phone_can_do_and_shows_the_address(self):
        widget = phone_widget({"enabled": False})
        with patch("desktop_widget.messagebox") as box:
            box.askyesno.return_value = False
            widget.toggle_phone()
            widget.executor.submit.assert_not_called()
            question = box.askyesno.call_args.args[1]
            self.assertIn("approve or decline Codex", question)
            self.assertIn("send replies", question)
            box.askyesno.return_value = True
            widget.toggle_phone()
            widget.executor.submit.assert_called_once_with(widget.post_local, "/api/phone", {"enabled": True})
            finish(widget, {"phone": {"enabled": True, "listening": True, "url": "http://192.168.1.20:43917", "adapter": "Wi-Fi"},
                            "code": "ABCDEFGH"})
            said = box.showinfo.call_args.args[1]
        self.assertIn("http://192.168.1.20:43917", said)
        self.assertIn("ABCDEFGH", said)
        self.assertTrue(widget.phone["enabled"])

    def test_turning_off_needs_no_question(self):
        widget = phone_widget({"enabled": True, "listening": True})
        with patch("desktop_widget.messagebox") as box:
            widget.toggle_phone()
            box.askyesno.assert_not_called()
            widget.executor.submit.assert_called_once_with(widget.post_local, "/api/phone", {"enabled": False})
            finish(widget, {"phone": {"enabled": False, "listening": False}})
            self.assertIn("signed out", box.showinfo.call_args.args[1])
        self.assertFalse(widget.phone["enabled"])

    def test_on_but_not_listening_says_why(self):
        widget = phone_widget({"enabled": False})
        with patch("desktop_widget.messagebox") as box:
            box.askyesno.return_value = True
            widget.toggle_phone()
            finish(widget, {"phone": {"enabled": True, "listening": False, "problem": "Windows marks the network as Public."}})
            self.assertIn("Public", box.showwarning.call_args.args[1])

    def test_a_new_pairing_code_forgets_phones(self):
        widget = phone_widget({"enabled": True, "listening": True, "url": "http://192.168.1.20:43917"})
        with patch("desktop_widget.messagebox") as box:
            box.askyesno.return_value = True
            widget.reset_pairing()
            widget.executor.submit.assert_called_once_with(widget.post_local, "/api/phone/reset")
            finish(widget, {"phone": widget.phone, "code": "JKLMNPQR"})
            self.assertIn("JKLMNPQR", box.showinfo.call_args.args[1])


if __name__ == "__main__":
    unittest.main()
