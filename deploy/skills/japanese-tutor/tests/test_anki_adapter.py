from __future__ import annotations

import importlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
SCRIPT = SCRIPT_DIR / "anki_adapter.py"
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

adapter = importlib.import_module("anki_adapter")
AdapterError = adapter.AdapterError
AnkiClient = adapter.AnkiClient
TARGET_DECKS = adapter.TARGET_DECKS
answer = adapter.answer
add_candidate_note = adapter.add_candidate_note
card_info = adapter.card_info
discover = adapter.discover
due = adapter.due
health = adapter.health
ensure_immersion_model = adapter.ensure_immersion_model
lesson_vocabulary = adapter.lesson_vocabulary
review_history = adapter.review_history
store_media = adapter.store_media
sync = adapter.sync


class FakeAnkiHandler(BaseHTTPRequestHandler):
    requests: list[dict] = []
    response: object = {"result": 6, "error": None}

    def do_POST(self) -> None:
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.__class__.requests.append(payload)
        body = json.dumps(self.__class__.response).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        pass


class FakeServer:
    def __enter__(self) -> str:
        FakeAnkiHandler.requests = []
        FakeAnkiHandler.response = {"result": 6, "error": None}
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeAnkiHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        host, port = self.server.server_address
        return f"http://{host}:{port}"

    def __exit__(self, *args: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class AnkiTransportTest(unittest.TestCase):
    def test_health_omits_key_and_bypasses_proxy(self) -> None:
        with FakeServer() as endpoint, patch.dict(
            os.environ, {"HTTP_PROXY": "http://127.0.0.1:1"}, clear=False
        ):
            self.assertEqual(health(AnkiClient(endpoint))["version"], 6)
        self.assertNotIn("key", FakeAnkiHandler.requests[0])

    def test_optional_key_is_sent(self) -> None:
        with FakeServer() as endpoint:
            health(AnkiClient(endpoint, "secret"))
        self.assertEqual(FakeAnkiHandler.requests[0]["key"], "secret")

    def test_authentication_error_is_classified(self) -> None:
        with FakeServer() as endpoint:
            FakeAnkiHandler.response = {"result": None, "error": "API key is invalid"}
            with self.assertRaisesRegex(AdapterError, "API key is invalid") as caught:
                health(AnkiClient(endpoint))
        self.assertEqual(caught.exception.code, "authentication_failed")

    def test_api_key_is_redacted_from_error(self) -> None:
        with FakeServer() as endpoint:
            FakeAnkiHandler.response = {"result": None, "error": "bad secret"}
            with self.assertRaises(AdapterError) as caught:
                health(AnkiClient(endpoint, "secret"))
        self.assertNotIn("secret", str(caught.exception))

    def test_cli_network_failure_uses_exit_code_two(self) -> None:
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "health", "--url", "http://127.0.0.1:1"],
            text=True,
            encoding="utf-8",
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stderr)["error"]["code"], "unavailable")

    def test_malformed_response_is_rejected(self) -> None:
        with FakeServer() as endpoint:
            FakeAnkiHandler.response = []
            with self.assertRaises(AdapterError) as caught:
                health(AnkiClient(endpoint))
        self.assertEqual(caught.exception.code, "malformed_response")

    def test_network_failure_is_recognizable(self) -> None:
        with self.assertRaises(AdapterError) as caught:
            health(AnkiClient("http://127.0.0.1:1", timeout=0.1))
        self.assertEqual(caught.exception.code, "unavailable")
        self.assertEqual(caught.exception.exit_code, 2)

    def test_sync_uses_anki_action(self) -> None:
        with FakeServer() as endpoint:
            FakeAnkiHandler.response = {"result": None, "error": None}
            self.assertTrue(sync(AnkiClient(endpoint))["ok"])
        self.assertEqual(FakeAnkiHandler.requests[0]["action"], "sync")


class DiscoverTest(unittest.TestCase):
    def test_discover_reports_structure_without_note_content(self) -> None:
        client = unittest.mock.Mock()

        def call(action: str, params: dict | None = None) -> object:
            if action == "deckNames":
                return list(TARGET_DECKS)
            if action == "findNotes":
                return [1, 2]
            if action == "notesInfo":
                return [
                    {
                        "modelName": "新标日",
                        "tags": ["初级", "第1课"],
                        "fields": {
                            "释义": {"value": "中国人", "order": 0},
                            "假名": {"value": "ちゅうごくじん [sound:word.mp3]", "order": 1},
                        },
                    },
                    {
                        "modelName": "新标日",
                        "tags": ["初级", "第1课"],
                        "fields": {
                            "释义": {"value": "中国人", "order": 0},
                            "假名": {"value": "ちゅうごくじん [sound:missing.mp3]", "order": 1},
                        },
                    },
                ]
            if action == "getMediaFilesNames":
                return ["word.mp3"]
            raise AssertionError((action, params))

        client.call.side_effect = call
        result = discover(client)
        report = result["decks"][0]
        self.assertEqual(report["note_count"], 2)
        self.assertEqual(report["duplicate_groups"], 1)
        self.assertEqual(report["missing_media"], 1)
        self.assertEqual(report["missing_media_samples"], ["missing.mp3"])
        self.assertNotIn("中国人", json.dumps(result, ensure_ascii=False))


def sample_card(card_id: int = 10, note_id: int = 20, deck: str = TARGET_DECKS[0]) -> dict:
    return {
        "cardId": card_id,
        "note": note_id,
        "deckName": deck,
        "modelName": "新标日",
        "ord": 0,
        "queue": 2,
        "type": 2,
        "due": 5,
        "interval": 3,
        "factor": 2500,
        "reps": 4,
        "lapses": 1,
        "fields": {
            "释义": {"value": "中国人", "order": 0},
            "日文": {"value": "ちゅうごくじん", "order": 1},
            "课号": {"value": "01", "order": 2},
            "音频": {"value": "[sound:word.mp3]", "order": 3},
        },
    }


class ReviewWorkflowTest(unittest.TestCase):
    def test_due_returns_scheduler_metadata(self) -> None:
        client = unittest.mock.Mock()

        def call(action: str, params: dict | None = None) -> object:
            if action == "findCards":
                return [10, 11, 12] if TARGET_DECKS[0] in params["query"] else []
            if action == "cardsInfo":
                self.assertEqual(params["cards"], [10])
                return [sample_card()]
            raise AssertionError((action, params))

        client.call.side_effect = call
        result = due(client, 1)
        self.assertEqual(result["total_due"], 3)
        self.assertEqual(len(result["cards"]), 1)
        self.assertEqual(result["cards"][0]["lapses"], 1)
        self.assertEqual(
            result["cards"][0]["curriculum_mapping"], {"level": "beginner", "lesson": "01"}
        )

    def test_card_info_rejects_malformed_response(self) -> None:
        client = unittest.mock.Mock()
        client.call.return_value = [None]
        with self.assertRaises(AdapterError):
            card_info(client, [10])

    def test_review_history_is_newest_first_and_limited(self) -> None:
        client = unittest.mock.Mock()
        client.call.return_value = {
            "10": [{"id": 1, "ease": 1}, {"id": 3, "ease": 3}, {"id": 2, "ease": 2}]
        }
        result = review_history(client, [10], 2)
        self.assertEqual([item["id"] for item in result["reviews"]["10"]], [3, 2])

    def test_lesson_vocabulary_uses_lesson_and_unit(self) -> None:
        client = unittest.mock.Mock()

        def call(action: str, params: dict | None = None) -> object:
            if action == "findNotes":
                self.assertIn('课号:"01"', params["query"])
                self.assertIn('tag:"初级第1单元"', params["query"])
                return [20]
            if action == "notesInfo":
                return [
                    {
                        "noteId": 20,
                        "modelName": "新标日",
                        "tags": ["初级第1单元", "初级第1课"],
                        "cards": [10],
                        "fields": sample_card()["fields"],
                    }
                ]
            if action == "cardsInfo":
                return [sample_card()]
            raise AssertionError((action, params))

        client.call.side_effect = call
        result = lesson_vocabulary(client, "beginner", "1", 1)
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["vocabulary"][0]["max_lapses"], 1)
        self.assertEqual(result["vocabulary"][0]["media"], ["word.mp3"])

    def test_automatic_rating_rules(self) -> None:
        cases = (
            ({"outcome": "incorrect"}, 1),
            ({"outcome": "correct", "answer_revealed": True}, 1),
            ({"outcome": "correct", "used_hint": True}, 2),
            ({"outcome": "correct", "attempts": 2}, 2),
            ({"outcome": "correct"}, 3),
            ({"outcome": "correct", "explicit_easy": True}, 4),
        )
        for overrides, expected in cases:
            client = unittest.mock.Mock()
            client.call.side_effect = [[sample_card()], [True], [True]]
            arguments = {
                "mode": "auto",
                "outcome": None,
                "used_hint": False,
                "attempts": 1,
                "answer_revealed": False,
                "explicit_easy": False,
                "manual_rating": None,
                **overrides,
            }
            with self.subTest(overrides=overrides):
                result = answer(client, 10, **arguments)
                self.assertEqual(result["ease"], expected)
                self.assertEqual(
                    client.call.call_args_list[-1].args,
                    ("answerCards", {"answers": [{"cardId": 10, "ease": expected}]}),
                )

    def test_practice_and_pending_manual_mode_do_not_write(self) -> None:
        for mode in ("practice", "manual"):
            client = unittest.mock.Mock()
            result = answer(
                client,
                10,
                mode=mode,
                outcome="correct",
                used_hint=False,
                attempts=1,
                answer_revealed=False,
                explicit_easy=False,
                manual_rating=None,
            )
            self.assertFalse(result["submitted"])
            client.call.assert_not_called()

    def test_manual_rating_is_submitted(self) -> None:
        client = unittest.mock.Mock()
        client.call.side_effect = [[sample_card()], [True], [True]]
        result = answer(
            client,
            10,
            mode="manual",
            outcome=None,
            used_hint=False,
            attempts=1,
            answer_revealed=False,
            explicit_easy=False,
            manual_rating="hard",
        )
        self.assertEqual(result["ease"], 2)

    def test_answer_rejects_unrelated_or_not_due_card(self) -> None:
        arguments = {
            "mode": "auto",
            "outcome": "correct",
            "used_hint": False,
            "attempts": 1,
            "answer_revealed": False,
            "explicit_easy": False,
            "manual_rating": None,
        }
        unrelated = unittest.mock.Mock()
        unrelated.call.return_value = [sample_card(deck="其他牌组")]
        with self.assertRaises(AdapterError) as caught:
            answer(unrelated, 10, **arguments)
        self.assertEqual(caught.exception.code, "card_not_allowed")

        not_due = unittest.mock.Mock()
        not_due.call.side_effect = [[sample_card()], [False]]
        with self.assertRaises(AdapterError) as caught:
            answer(not_due, 10, **arguments)
        self.assertEqual(caught.exception.code, "card_not_due")
        self.assertNotIn("answerCards", [call.args[0] for call in not_due.call.call_args_list])


class ImmersionMutationTest(unittest.TestCase):
    def test_ensure_model_creates_fixed_structure(self) -> None:
        client = unittest.mock.Mock()
        client.call.side_effect = [[], 1, 123]
        result = ensure_immersion_model(client)
        self.assertTrue(result["created"])
        create = client.call.call_args_list[2]
        self.assertEqual(create.args[0], "createModel")
        self.assertEqual(create.args[1]["modelName"], "Japanese Immersion")
        self.assertEqual(result["deck"], "日语沉浸学习")
        self.assertEqual(create.args[1]["inOrderFields"][0], "CandidateId")
        self.assertIn("{{#Audio}}", create.args[1]["cardTemplates"][2]["Front"])

    def test_existing_model_is_verified_without_update(self) -> None:
        client = unittest.mock.Mock()
        templates = {
            item["Name"]: {"Front": item["Front"], "Back": item["Back"]}
            for item in adapter.IMMERSION_TEMPLATES
        }
        client.call.side_effect = [
            [adapter.IMMERSION_MODEL],
            list(adapter.IMMERSION_FIELDS),
            templates,
            {"css": adapter.IMMERSION_CSS},
            1,
        ]
        self.assertFalse(ensure_immersion_model(client)["created"])
        self.assertNotIn("createModel", [call.args[0] for call in client.call.call_args_list])

    def test_model_conflict_does_not_create_deck(self) -> None:
        client = unittest.mock.Mock()
        client.call.side_effect = [
            [adapter.IMMERSION_MODEL],
            ["Wrong"],
            {},
            {"css": "wrong"},
        ]
        with self.assertRaises(AdapterError) as caught:
            ensure_immersion_model(client)
        self.assertEqual(caught.exception.code, "model_conflict")
        self.assertNotIn("createDeck", [call.args[0] for call in client.call.call_args_list])

    def test_media_is_base64_and_workspace_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            media = workspace / "audio.mp3"
            media.write_bytes(b"audio-bytes")
            client = unittest.mock.Mock()

            def call(action: str, params: dict) -> object:
                return [] if action == "getMediaFilesNames" else params["filename"]

            client.call.side_effect = call
            result = store_media(client, media, workspace)
            self.assertTrue(result["created"])
            payload = client.call.call_args_list[1].args[1]
            self.assertEqual(payload["data"], "YXVkaW8tYnl0ZXM=")
            self.assertNotIn("path", payload)

            with tempfile.TemporaryDirectory() as outside_dir:
                outside = Path(outside_dir) / "outside.mp3"
                outside.write_bytes(b"outside")
                with self.assertRaises(AdapterError) as caught:
                    store_media(client, outside, workspace)
                self.assertEqual(caught.exception.code, "workspace_violation")

    def test_existing_media_is_not_uploaded_again(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            media = workspace / "audio.mp3"
            media.write_bytes(b"audio-bytes")
            filename, _ = adapter.read_media(media, workspace)
            client = unittest.mock.Mock()
            client.call.return_value = [filename]
            result = store_media(client, media, workspace)
        self.assertFalse(result["created"])
        self.assertEqual([call.args[0] for call in client.call.call_args_list], ["getMediaFilesNames"])

    def test_add_note_only_targets_immersion_and_syncs(self) -> None:
        candidate = {
            "Japanese": "今日は晴れです。",
            "Reading": "きょうははれです。",
            "Meaning": "今天晴天。",
            "CurriculumNode": "beginner-01",
            "SourceRefs": ["generated"],
            "Generator": {"model": "test"},
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            client = unittest.mock.Mock()
            client.call.side_effect = [123, None]
            with (
                patch.object(adapter, "ensure_immersion_model"),
                patch.object(adapter, "find_candidate", return_value={"note_ids": []}),
            ):
                result = add_candidate_note(client, candidate, Path(temp_dir), confirmed=True)
        self.assertEqual(result, {"ok": True, "status": "synced", "note_id": 123})
        note = client.call.call_args_list[0].args[1]["note"]
        self.assertEqual(note["deckName"], "日语沉浸学习")
        self.assertEqual(note["modelName"], "Japanese Immersion")

    def test_empty_candidate_text_is_rejected(self) -> None:
        candidate = {
            "Japanese": " ",
            "Reading": "にほんご",
            "Meaning": "日语",
            "CurriculumNode": "beginner-01",
            "SourceRefs": [],
            "Generator": {},
        }
        with self.assertRaises(AdapterError) as caught:
            adapter.candidate_fields(candidate)
        self.assertEqual(caught.exception.code, "invalid_arguments")

    def test_existing_candidate_only_retries_sync(self) -> None:
        candidate = {
            "Japanese": "日本語",
            "Reading": "にほんご",
            "Meaning": "日语",
            "CurriculumNode": "beginner-01",
            "SourceRefs": [],
            "Generator": {},
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            client = unittest.mock.Mock()
            client.call.return_value = None
            with (
                patch.object(adapter, "ensure_immersion_model"),
                patch.object(adapter, "find_candidate", return_value={"note_ids": [456]}),
            ):
                result = add_candidate_note(client, candidate, Path(temp_dir), confirmed=True)
        self.assertEqual(result["status"], "synced_existing")
        self.assertEqual([call.args[0] for call in client.call.call_args_list], ["sync"])

    def test_duplicate_candidate_ids_stop_before_write(self) -> None:
        candidate = {
            "Japanese": "日本語",
            "Reading": "にほんご",
            "Meaning": "日语",
            "CurriculumNode": "beginner-01",
            "SourceRefs": [],
            "Generator": {},
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            client = unittest.mock.Mock()
            with (
                patch.object(adapter, "ensure_immersion_model"),
                patch.object(adapter, "find_candidate", return_value={"note_ids": [1, 2]}),
            ):
                with self.assertRaises(AdapterError) as caught:
                    add_candidate_note(client, candidate, Path(temp_dir), confirmed=True)
        self.assertEqual(caught.exception.code, "candidate_conflict")
        client.call.assert_not_called()

    def test_sync_failure_preserves_written_note_id(self) -> None:
        candidate = {
            "Japanese": "日本語",
            "Reading": "にほんご",
            "Meaning": "日语",
            "CurriculumNode": "beginner-01",
            "SourceRefs": [],
            "Generator": {},
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            client = unittest.mock.Mock()
            client.call.side_effect = [789, AdapterError("unavailable", "offline")]
            with (
                patch.object(adapter, "ensure_immersion_model"),
                patch.object(adapter, "find_candidate", return_value={"note_ids": []}),
            ):
                result = add_candidate_note(client, candidate, Path(temp_dir), confirmed=True)
        self.assertEqual(result, {"ok": True, "status": "written_unsynced", "note_id": 789})

    def test_note_failure_does_not_sync(self) -> None:
        candidate = {
            "Japanese": "日本語",
            "Reading": "にほんご",
            "Meaning": "日语",
            "CurriculumNode": "beginner-01",
            "SourceRefs": [],
            "Generator": {},
            "AudioPath": "audio.mp3",
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            client = unittest.mock.Mock()
            client.call.side_effect = AdapterError("anki_error", "add failed")
            with (
                patch.object(adapter, "ensure_immersion_model"),
                patch.object(adapter, "find_candidate", return_value={"note_ids": []}),
                patch.object(
                    adapter,
                    "store_media",
                    return_value={"filename": "audio.mp3", "created": True},
                ) as media_store,
            ):
                with self.assertRaises(AdapterError):
                    add_candidate_note(client, candidate, Path(temp_dir), confirmed=True)
        media_store.assert_called_once()
        self.assertEqual([call.args[0] for call in client.call.call_args_list], ["addNote"])
