"""API tests for the board contents listing endpoint."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from topix.api.router.boards import router
from topix.api.utils.security import get_current_user_uid
from topix.datatypes.graph.graph import Graph
from topix.datatypes.note.note import Note, NoteProperties
from topix.datatypes.note.style import NodeType, Style
from topix.datatypes.property import IconProperty


class _FakeGraphStore:
    """Minimal async store used by router tests."""

    def __init__(self):
        self.roles: dict[tuple[str, str], str] = {}
        self.metadata: dict[str, Graph] = {}
        self.graphs: dict[str, Graph] = {}

    async def get_graph_role(self, graph_uid: str, user_uid: str) -> str | None:
        return self.roles.get((graph_uid, user_uid))

    async def get_graph_metadata(self, graph_uid: str) -> Graph | None:
        return self.metadata.get(graph_uid)

    async def get_graph(self, graph_uid: str, root_id: str | None = None) -> Graph | None:
        return self.graphs.get(graph_uid)


def _build_client(store: _FakeGraphStore, user_uid: str = "owner") -> TestClient:
    app = FastAPI()
    app.include_router(router)
    app.graph_store = store

    async def _fake_current_user_uid():
        return user_uid

    app.dependency_overrides[get_current_user_uid] = _fake_current_user_uid
    return TestClient(app)


def _make_sheet(node_id: str, label: str, icon: IconProperty.Phosphor | None = None) -> Note:
    """Build a sheet-style Note, optionally with a phosphor icon set."""
    props = NoteProperties()
    if icon is not None:
        props.icon_data = IconProperty(icon=icon)
    return Note(
        id=node_id,
        label={"markdown": label},
        graph_uid="g-1",
        properties=props,
        style=Style(type=NodeType.SHEET),
    )


def test_list_board_contents_includes_icon_data_for_phosphor_sheets():
    """The contents endpoint should serialize the inner icon value when set."""
    store = _FakeGraphStore()
    graph_uid = "g-1"
    sheet = _make_sheet(
        "n-1",
        "Daily notes",
        icon=IconProperty.Phosphor(name="Lightbulb", color="#dc2626"),
    )
    store.metadata[graph_uid] = Graph(uid=graph_uid, label="Board", visibility="public")
    store.graphs[graph_uid] = Graph(uid=graph_uid, label="Board", visibility="public", nodes=[sheet])
    client = _build_client(store)

    response = client.get(f"/boards/{graph_uid}/contents")

    assert response.status_code == 200
    items = response.json()["data"]["items"]
    assert len(items) == 1
    assert items[0]["id"] == "n-1"
    assert items[0]["icon_data"] == {
        "type": "phosphor",
        "name": "Lightbulb",
        "color": "#dc2626",
    }


def test_list_board_contents_returns_null_icon_data_when_unset():
    """Sheets without an explicit icon should report `icon_data: null`."""
    store = _FakeGraphStore()
    graph_uid = "g-1"
    sheet = _make_sheet("n-2", "Plain sheet")
    store.metadata[graph_uid] = Graph(uid=graph_uid, label="Board", visibility="public")
    store.graphs[graph_uid] = Graph(uid=graph_uid, label="Board", visibility="public", nodes=[sheet])
    client = _build_client(store)

    response = client.get(f"/boards/{graph_uid}/contents")

    assert response.status_code == 200
    items = response.json()["data"]["items"]
    assert items[0]["icon_data"] is None


def test_list_board_contents_serializes_emoji_variant_unchanged():
    """The emoji variant of iconData should pass through verbatim."""
    store = _FakeGraphStore()
    graph_uid = "g-1"
    sheet = _make_sheet("n-3", "Sheet with emoji")
    sheet.properties.icon_data = IconProperty(icon=IconProperty.Emoji(emoji="🎯"))
    store.metadata[graph_uid] = Graph(uid=graph_uid, label="Board", visibility="public")
    store.graphs[graph_uid] = Graph(uid=graph_uid, label="Board", visibility="public", nodes=[sheet])
    client = _build_client(store)

    response = client.get(f"/boards/{graph_uid}/contents")

    items = response.json()["data"]["items"]
    assert items[0]["icon_data"] == {"type": "emoji", "emoji": "🎯"}


def test_list_board_contents_lists_custom_surfaces_but_not_deprecated_types():
    """Applets join sheet/folder/code-sandbox; deprecated widget/mini-app and plain shapes stay out."""
    store = _FakeGraphStore()
    graph_uid = "g-1"
    nodes = [
        Note(id=f"n-{t.value}", graph_uid=graph_uid, style=Style(type=t))
        for t in (
            NodeType.SHEET, NodeType.FOLDER, NodeType.CODE_SANDBOX, NodeType.APPLET,
            NodeType.WIDGET, NodeType.MINI_APP, NodeType.RECTANGLE,
        )
    ]
    store.metadata[graph_uid] = Graph(uid=graph_uid, label="Board", visibility="public")
    store.graphs[graph_uid] = Graph(uid=graph_uid, label="Board", visibility="public", nodes=nodes)
    client = _build_client(store)

    response = client.get(f"/boards/{graph_uid}/contents")

    assert response.status_code == 200
    kinds = sorted(item["kind"] for item in response.json()["data"]["items"])
    assert kinds == ["applet", "code-sandbox", "folder", "sheet"]
