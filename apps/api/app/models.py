"""Pydantic models for wire contracts (REST).

These mirror docs/protocol.md. Field names use camelCase on the wire; aliases
let us keep idiomatic snake_case in Python while serialising to the contract.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


_CAMEL = ConfigDict(populate_by_name=True, alias_generator=None)


class User(BaseModel):
    id: int
    handle: str
    name: str
    color: str


class Block(BaseModel):
    model_config = _CAMEL

    block_id: str = Field(alias="blockId")
    parent_id: str | None = Field(default=None, alias="parentId")
    position: str
    depth: int
    type: str
    content: dict[str, Any]
    version: int


class BlocksResponse(BaseModel):
    model_config = _CAMEL

    doc_id: int = Field(alias="docId")
    blocks: list[Block]
    last_stream_id: str = Field(alias="lastStreamId")


OpType = Literal[
    "insert_block",
    "delete_block",
    "move_block",
    "update_attrs",
    "update_content",
]


class BlockOperation(BaseModel):
    model_config = _CAMEL

    op: OpType
    block_id: str = Field(alias="blockId")
    payload: dict[str, Any] = Field(default_factory=dict)
    version: int | None = None


class OperationsRequest(BaseModel):
    model_config = _CAMEL

    client_seq: int = Field(alias="clientSeq")
    ops: list[BlockOperation]


class OpResult(BaseModel):
    model_config = _CAMEL

    block_id: str = Field(alias="blockId")
    new_version: int = Field(alias="newVersion")
    status: Literal["applied", "conflict"]
    # On conflict we echo back the server's current view of the block so the
    # client can rebase without a round-trip.
    current: Block | None = None


class OperationsResponse(BaseModel):
    model_config = _CAMEL

    results: list[OpResult]
    stream_id: str | None = Field(default=None, alias="streamId")


class PresignRequest(BaseModel):
    model_config = _CAMEL

    content_type: str = Field(alias="contentType")
    size: int


class PresignResponse(BaseModel):
    model_config = _CAMEL

    upload_url: str = Field(alias="uploadUrl")
    public_url: str = Field(alias="publicUrl")
    image_id: str = Field(alias="imageId")
