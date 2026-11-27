// Generated with node scripts/generate-agent-task-schemas.ts.
// Shared runtime schemas remain authoritative; host supplies project identity and replay keys.
export const AGENT_TASK_TOOL_SCHEMA_HASH="e7b72ca805f31f9b531ad40f8f2353916297c94791774ac6b654ae8258c8bb13";
export const AGENT_TASK_TOOL_SCHEMAS:Readonly<Record<string,unknown>>={
 "sequence.preview": {
  "type": "object",
  "properties": {
   "actionId": {
    "type": "string",
    "format": "uuid"
   },
   "originSide": {
    "type": "string",
    "enum": [
     "board",
     "timeline"
    ]
   },
   "origin": {
    "type": "string",
    "enum": [
     "user",
     "mio"
    ]
   },
   "intents": {
    "type": "array",
    "items": {
     "type": "object",
     "properties": {
      "side": {
       "type": "string",
       "enum": [
        "board",
        "timeline"
       ]
      },
      "operation": {
       "anyOf": [
        {
         "type": "object",
         "properties": {
          "kind": {
           "type": "string",
           "const": "board"
          },
          "edit": {
           "anyOf": [
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "connect"
              },
              "fromId": {
               "type": "string",
               "format": "uuid"
              },
              "toId": {
               "type": "string",
               "format": "uuid"
              }
             },
             "required": [
              "kind",
              "fromId",
              "toId"
             ],
             "additionalProperties": false
            },
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "disconnect"
              },
              "fromId": {
               "type": "string",
               "format": "uuid"
              },
              "toId": {
               "type": "string",
               "format": "uuid"
              }
             },
             "required": [
              "kind",
              "fromId",
              "toId"
             ],
             "additionalProperties": false
            },
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "insert"
              },
              "fromId": {
               "type": "string",
               "format": "uuid"
              },
              "toId": {
               "type": "string",
               "format": "uuid"
              },
              "nodeId": {
               "type": "string",
               "format": "uuid"
              }
             },
             "required": [
              "kind",
              "fromId",
              "toId",
              "nodeId"
             ],
             "additionalProperties": false
            },
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "delete"
              },
              "nodeId": {
               "type": "string",
               "format": "uuid"
              }
             },
             "required": [
              "kind",
              "nodeId"
             ],
             "additionalProperties": false
            }
           ]
          }
         },
         "required": [
          "kind",
          "edit"
         ],
         "additionalProperties": false
        },
        {
         "type": "object",
         "properties": {
          "kind": {
           "type": "string",
           "const": "sync-board"
          },
          "newClipIds": {
           "type": "object",
           "additionalProperties": {
            "type": "string",
            "format": "uuid"
           },
           "propertyNames": {
            "format": "uuid"
           }
          }
         },
         "required": [
          "kind"
         ],
         "additionalProperties": false
        },
        {
         "type": "object",
         "properties": {
          "kind": {
           "type": "string",
           "const": "board-version"
          },
          "nodeId": {
           "type": "string",
           "format": "uuid"
          },
          "version": {
           "anyOf": [
            {
             "type": "object",
             "properties": {
              "id": {
               "type": "string",
               "format": "uuid"
              },
              "sourceFrames": {
               "anyOf": [
                {
                 "type": "integer",
                 "minimum": 0,
                 "maximum": 9007199254740991
                },
                {
                 "type": "null"
                }
               ]
              }
             },
             "required": [
              "id",
              "sourceFrames"
             ],
             "additionalProperties": false
            },
            {
             "type": "null"
            }
           ]
          }
         },
         "required": [
          "kind",
          "nodeId",
          "version"
         ],
         "additionalProperties": false
        },
        {
         "type": "object",
         "properties": {
          "kind": {
           "type": "string",
           "const": "board.root.create"
          },
          "nodeId": {
           "type": "string",
           "format": "uuid"
          },
          "name": {
           "type": "string",
           "minLength": 1,
           "maxLength": 150
          },
          "position": {
           "type": "object",
           "properties": {
            "x": {
             "type": "number"
            },
            "y": {
             "type": "number"
            }
           },
           "required": [
            "x",
            "y"
           ],
           "additionalProperties": false
          }
         },
         "required": [
          "kind",
          "nodeId",
          "name",
          "position"
         ],
         "additionalProperties": false
        },
        {
         "type": "object",
         "properties": {
          "kind": {
           "type": "string",
           "const": "board.shot.append"
          },
          "nodeId": {
           "type": "string",
           "format": "uuid"
          },
          "name": {
           "type": "string",
           "minLength": 1,
           "maxLength": 150
          },
          "position": {
           "type": "object",
           "properties": {
            "x": {
             "type": "number"
            },
            "y": {
             "type": "number"
            }
           },
           "required": [
            "x",
            "y"
           ],
           "additionalProperties": false
          }
         },
         "required": [
          "kind",
          "nodeId",
          "name"
         ],
         "additionalProperties": false
        },
        {
         "type": "object",
         "properties": {
          "kind": {
           "type": "string",
           "const": "board.layout.move"
          },
          "moves": {
           "type": "array",
           "items": {
            "type": "object",
            "properties": {
             "nodeId": {
              "type": "string",
              "format": "uuid"
             },
             "x": {
              "type": "number"
             },
             "y": {
              "type": "number"
             }
            },
            "required": [
             "nodeId",
             "x",
             "y"
            ],
            "additionalProperties": false
           },
           "minItems": 1,
           "maxItems": 500
          }
         },
         "required": [
          "kind",
          "moves"
         ],
         "additionalProperties": false
        },
        {
         "type": "object",
         "properties": {
          "kind": {
           "type": "string",
           "const": "board.node.create"
          },
          "nodeId": {
           "type": "string",
           "format": "uuid"
          },
          "nodeType": {
           "type": "string",
           "enum": [
            "image",
            "video",
            "audio",
            "text"
           ]
          },
          "name": {
           "type": "string",
           "minLength": 1,
           "maxLength": 150
          },
          "position": {
           "type": "object",
           "properties": {
            "x": {
             "type": "number"
            },
            "y": {
             "type": "number"
            }
           },
           "required": [
            "x",
            "y"
           ],
           "additionalProperties": false
          },
          "assetId": {
           "type": "string",
           "format": "uuid"
          },
          "text": {
           "type": "string",
           "maxLength": 5000
          }
         },
         "required": [
          "kind",
          "nodeId",
          "nodeType",
          "name",
          "position"
         ],
         "additionalProperties": false
        },
        {
         "type": "object",
         "properties": {
          "kind": {
           "type": "string",
           "const": "board.shot.update"
          },
          "shotId": {
           "type": "string",
           "format": "uuid"
          },
          "expectedRevision": {
           "type": "integer",
           "minimum": 1,
           "maximum": 9007199254740991
          },
          "patch": {
           "type": "object",
           "properties": {
            "title": {
             "type": "string",
             "minLength": 1,
             "maxLength": 500
            },
            "prompt": {
             "type": "string",
             "maxLength": 20000
            },
            "duration": {
             "type": "number",
             "minimum": 0.05,
             "maximum": 600
            },
            "aspectRatio": {
             "type": "string",
             "enum": [
              "9:16",
              "16:9"
             ]
            },
            "position": {
             "type": "object",
             "properties": {
              "x": {
               "type": "number"
              },
              "y": {
               "type": "number"
              }
             },
             "required": [
              "x",
              "y"
             ],
             "additionalProperties": false
            }
           },
           "additionalProperties": false
          }
         },
         "required": [
          "kind",
          "shotId",
          "expectedRevision",
          "patch"
         ],
         "additionalProperties": false
        },
        {
         "type": "object",
         "properties": {
          "kind": {
           "type": "string",
           "const": "board.node.update"
          },
          "nodeId": {
           "type": "string",
           "format": "uuid"
          },
          "expectedRevision": {
           "type": "integer",
           "minimum": 1,
           "maximum": 9007199254740991
          },
          "patch": {
           "type": "object",
           "properties": {
            "name": {
             "type": "string",
             "minLength": 1,
             "maxLength": 150
            },
            "text": {
             "type": "string",
             "maxLength": 5000
            },
            "position": {
             "type": "object",
             "properties": {
              "x": {
               "type": "number"
              },
              "y": {
               "type": "number"
              }
             },
             "required": [
              "x",
              "y"
             ],
             "additionalProperties": false
            }
           },
           "additionalProperties": false
          }
         },
         "required": [
          "kind",
          "nodeId",
          "expectedRevision",
          "patch"
         ],
         "additionalProperties": false
        },
        {
         "type": "object",
         "properties": {
          "kind": {
           "type": "string",
           "const": "board.restore"
          },
          "items": {
           "type": "array",
           "items": {
            "type": "object",
            "properties": {
             "kind": {
              "type": "string",
              "enum": [
               "shot",
               "node"
              ]
             },
             "id": {
              "type": "string",
              "format": "uuid"
             }
            },
            "required": [
             "kind",
             "id"
            ],
            "additionalProperties": false
           },
           "minItems": 1,
           "maxItems": 50
          }
         },
         "required": [
          "kind",
          "items"
         ],
         "additionalProperties": false
        },
        {
         "type": "object",
         "properties": {
          "kind": {
           "type": "string",
           "const": "board.paste"
          },
          "documentId": {
           "type": "string",
           "format": "uuid"
          },
          "snapshotId": {
           "type": "string",
           "format": "uuid"
          },
          "viewport": {
           "type": "object",
           "properties": {
            "x": {
             "type": "number"
            },
            "y": {
             "type": "number"
            },
            "width": {
             "type": "number",
             "exclusiveMinimum": 0
            },
            "height": {
             "type": "number",
             "exclusiveMinimum": 0
            }
           },
           "required": [
            "x",
            "y",
            "width",
            "height"
           ],
           "additionalProperties": false
          }
         },
         "required": [
          "kind",
          "documentId",
          "snapshotId",
          "viewport"
         ],
         "additionalProperties": false
        },
        {
         "type": "object",
         "properties": {
          "kind": {
           "type": "string",
           "const": "board.duplicate"
          },
          "items": {
           "type": "array",
           "items": {
            "type": "object",
            "properties": {
             "kind": {
              "type": "string",
              "enum": [
               "shot",
               "node"
              ]
             },
             "id": {
              "type": "string",
              "format": "uuid"
             }
            },
            "required": [
             "kind",
             "id"
            ],
            "additionalProperties": false
           },
           "minItems": 1,
           "maxItems": 50
          },
          "viewport": {
           "type": "object",
           "properties": {
            "x": {
             "type": "number"
            },
            "y": {
             "type": "number"
            },
            "width": {
             "type": "number",
             "exclusiveMinimum": 0
            },
            "height": {
             "type": "number",
             "exclusiveMinimum": 0
            }
           },
           "required": [
            "x",
            "y",
            "width",
            "height"
           ],
           "additionalProperties": false
          }
         },
         "required": [
          "kind",
          "items"
         ],
         "additionalProperties": false
        },
        {
         "type": "object",
         "properties": {
          "kind": {
           "type": "string",
           "const": "track"
          },
          "edit": {
           "anyOf": [
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "move"
              },
              "clipId": {
               "type": "string",
               "format": "uuid"
              },
              "beforeClipId": {
               "anyOf": [
                {
                 "type": "string",
                 "format": "uuid"
                },
                {
                 "type": "null"
                }
               ]
              },
              "copyNodeId": {
               "type": "string",
               "format": "uuid"
              }
             },
             "required": [
              "kind",
              "clipId",
              "beforeClipId"
             ],
             "additionalProperties": false
            },
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "move-off-track"
              },
              "clipId": {
               "type": "string",
               "format": "uuid"
              },
              "trackId": {
               "type": "string",
               "format": "uuid"
              },
              "startFrame": {
               "type": "integer",
               "minimum": 0,
               "maximum": 9007199254740991
              },
              "copyNodeId": {
               "type": "string",
               "format": "uuid"
              }
             },
             "required": [
              "kind",
              "clipId",
              "trackId",
              "startFrame"
             ],
             "additionalProperties": false
            },
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "remove"
              },
              "clipId": {
               "type": "string",
               "format": "uuid"
              }
             },
             "required": [
              "kind",
              "clipId"
             ],
             "additionalProperties": false
            },
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "add"
              },
              "clip": {
               "type": "object",
               "properties": {
                "id": {
                 "type": "string",
                 "format": "uuid"
                },
                "nodeId": {
                 "type": "string",
                 "format": "uuid"
                },
                "versionId": {
                 "anyOf": [
                  {
                   "type": "string",
                   "format": "uuid"
                  },
                  {
                   "type": "null"
                  }
                 ]
                },
                "versionLocked": {
                 "type": "boolean"
                },
                "startFrame": {
                 "type": "integer",
                 "minimum": 0,
                 "maximum": 9007199254740991
                },
                "durationFrames": {
                 "type": "integer",
                 "minimum": 0,
                 "maximum": 9007199254740991,
                 "exclusiveMinimum": 0
                },
                "sourceInFrame": {
                 "type": "integer",
                 "minimum": 0,
                 "maximum": 9007199254740991
                },
                "splitGroupId": {
                 "type": "string",
                 "format": "uuid"
                }
               },
               "required": [
                "id",
                "nodeId",
                "versionId",
                "versionLocked",
                "startFrame",
                "durationFrames",
                "sourceInFrame"
               ],
               "additionalProperties": false
              },
              "beforeClipId": {
               "anyOf": [
                {
                 "type": "string",
                 "format": "uuid"
                },
                {
                 "type": "null"
                }
               ]
              },
              "media": {
               "type": "object",
               "properties": {
                "nodeId": {
                 "type": "string",
                 "format": "uuid"
                },
                "selectedVersion": {
                 "anyOf": [
                  {
                   "type": "object",
                   "properties": {
                    "id": {
                     "type": "string",
                     "format": "uuid"
                    },
                    "sourceFrames": {
                     "anyOf": [
                      {
                       "type": "integer",
                       "minimum": 0,
                       "maximum": 9007199254740991
                      },
                      {
                       "type": "null"
                      }
                     ]
                    }
                   },
                   "required": [
                    "id",
                    "sourceFrames"
                   ],
                   "additionalProperties": false
                  },
                  {
                   "type": "null"
                  }
                 ]
                },
                "durationFrames": {
                 "type": "integer",
                 "minimum": 0,
                 "maximum": 9007199254740991,
                 "exclusiveMinimum": 0
                }
               },
               "required": [
                "nodeId",
                "selectedVersion",
                "durationFrames"
               ],
               "additionalProperties": false
              },
              "nodeKind": {
               "type": "string",
               "enum": [
                "shot",
                "video",
                "image"
               ]
              },
              "nodeAssetId": {
               "type": "string",
               "format": "uuid"
              },
              "nodeName": {
               "type": "string",
               "minLength": 1,
               "maxLength": 150
              },
              "copyFromClipId": {
               "type": "string",
               "format": "uuid"
              }
             },
             "required": [
              "kind",
              "clip",
              "beforeClipId"
             ],
             "additionalProperties": false
            },
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "insert-asset"
              },
              "assetId": {
               "type": "string",
               "format": "uuid"
              },
              "trackId": {
               "anyOf": [
                {
                 "type": "string",
                 "format": "uuid"
                },
                {
                 "type": "null"
                }
               ]
              },
              "startFrame": {
               "type": "integer",
               "minimum": 0,
               "maximum": 9007199254740991
              }
             },
             "required": [
              "kind",
              "assetId",
              "trackId",
              "startFrame"
             ],
             "additionalProperties": false
            },
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "paste-clip"
              },
              "clipId": {
               "type": "string",
               "format": "uuid"
              },
              "startFrame": {
               "type": "integer",
               "minimum": 0,
               "maximum": 9007199254740991
              }
             },
             "required": [
              "kind",
              "clipId",
              "startFrame"
             ],
             "additionalProperties": false
            },
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "copy-as-new-shot"
              },
              "clipId": {
               "type": "string",
               "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
              },
              "newClipId": {
               "type": "string",
               "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
              },
              "copyNodeId": {
               "type": "string",
               "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
              }
             },
             "required": [
              "kind",
              "clipId",
              "newClipId",
              "copyNodeId"
             ],
             "additionalProperties": false
            },
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "add-overlay"
              },
              "clipId": {
               "type": "string",
               "format": "uuid"
              },
              "trackId": {
               "type": "string",
               "format": "uuid"
              },
              "startFrame": {
               "type": "integer",
               "minimum": 0,
               "maximum": 9007199254740991
              },
              "durationFrames": {
               "type": "integer",
               "minimum": 0,
               "maximum": 9007199254740991,
               "exclusiveMinimum": 0
              },
              "sourceInFrame": {
               "type": "integer",
               "minimum": 0,
               "maximum": 9007199254740991
              },
              "name": {
               "type": "string",
               "minLength": 1,
               "maxLength": 200
              },
              "assetId": {
               "type": "string",
               "format": "uuid"
              },
              "copyFromClipId": {
               "type": "string",
               "format": "uuid"
              }
             },
             "required": [
              "kind",
              "clipId",
              "trackId",
              "startFrame",
              "durationFrames",
              "sourceInFrame",
              "name"
             ],
             "additionalProperties": false
            },
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "split"
              },
              "clipId": {
               "type": "string",
               "format": "uuid"
              },
              "offsetFrames": {
               "type": "integer",
               "minimum": 0,
               "maximum": 9007199254740991,
               "exclusiveMinimum": 0
              },
              "rightClipId": {
               "type": "string",
               "format": "uuid"
              },
              "rightSourceInFrame": {
               "type": "integer",
               "minimum": 0,
               "maximum": 9007199254740991
              }
             },
             "required": [
              "kind",
              "clipId",
              "offsetFrames",
              "rightClipId"
             ],
             "additionalProperties": false
            },
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "trim"
              },
              "clipId": {
               "type": "string",
               "format": "uuid"
              },
              "durationFrames": {
               "type": "integer",
               "minimum": 0,
               "maximum": 9007199254740991,
               "exclusiveMinimum": 0
              },
              "sourceInFrame": {
               "type": "integer",
               "minimum": 0,
               "maximum": 9007199254740991
              }
             },
             "required": [
              "kind",
              "clipId",
              "durationFrames"
             ],
             "additionalProperties": false
            },
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "version"
              },
              "clipId": {
               "type": "string",
               "format": "uuid"
              },
              "version": {
               "anyOf": [
                {
                 "type": "object",
                 "properties": {
                  "id": {
                   "type": "string",
                   "format": "uuid"
                  },
                  "sourceFrames": {
                   "anyOf": [
                    {
                     "type": "integer",
                     "minimum": 0,
                     "maximum": 9007199254740991
                    },
                    {
                     "type": "null"
                    }
                   ]
                  }
                 },
                 "required": [
                  "id",
                  "sourceFrames"
                 ],
                 "additionalProperties": false
                },
                {
                 "type": "null"
                }
               ]
              },
              "locked": {
               "type": "boolean"
              }
             },
             "required": [
              "kind",
              "clipId",
              "version",
              "locked"
             ],
             "additionalProperties": false
            },
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "split-at-scenes"
              },
              "assetId": {
               "type": "string",
               "format": "uuid"
              },
              "resultId": {
               "type": "string",
               "format": "uuid"
              }
             },
             "required": [
              "kind",
              "assetId",
              "resultId"
             ],
             "additionalProperties": false
            }
           ]
          }
         },
         "required": [
          "kind",
          "edit"
         ],
         "additionalProperties": false
        }
       ]
      }
     },
     "required": [
      "side",
      "operation"
     ],
     "additionalProperties": false
    },
    "minItems": 1,
    "maxItems": 64
   },
   "subjectIntent": {
    "type": "object",
    "properties": {
     "side": {
      "type": "string",
      "const": "board"
     },
     "operation": {
      "anyOf": [
       {
        "type": "object",
        "properties": {
         "kind": {
          "type": "string",
          "const": "subject-binding"
         },
         "edit": {
          "anyOf": [
           {
            "type": "object",
            "properties": {
             "kind": {
              "type": "string",
              "const": "create"
             },
             "bindingId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             },
             "shotId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             },
             "subjectId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             },
             "role": {
              "type": "string",
              "enum": [
               "subject",
               "style"
              ]
             }
            },
            "required": [
             "kind",
             "bindingId",
             "shotId",
             "subjectId",
             "role"
            ],
            "additionalProperties": false
           },
           {
            "type": "object",
            "properties": {
             "kind": {
              "type": "string",
              "const": "set-mode"
             },
             "bindingId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             },
             "bindingMode": {
              "type": "string",
              "enum": [
               "follow",
               "locked"
              ]
             },
             "subjectVersionId": {
              "anyOf": [
               {
                "type": "string",
                "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
               },
               {
                "type": "null"
               }
              ]
             }
            },
            "required": [
             "kind",
             "bindingId",
             "bindingMode",
             "subjectVersionId"
            ],
            "additionalProperties": false
           },
           {
            "type": "object",
            "properties": {
             "kind": {
              "type": "string",
              "const": "detach"
             },
             "bindingId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             }
            },
            "required": [
             "kind",
             "bindingId"
            ],
            "additionalProperties": false
           },
           {
            "type": "object",
            "properties": {
             "kind": {
              "type": "string",
              "const": "restore"
             },
             "bindingId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             },
             "bindingMode": {
              "type": "string",
              "enum": [
               "follow",
               "locked"
              ]
             },
             "subjectVersionId": {
              "anyOf": [
               {
                "type": "string",
                "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
               },
               {
                "type": "null"
               }
              ]
             }
            },
            "required": [
             "kind",
             "bindingId",
             "bindingMode",
             "subjectVersionId"
            ],
            "additionalProperties": false
           }
          ]
         }
        },
        "required": [
         "kind",
         "edit"
        ],
        "additionalProperties": false
       },
       {
        "anyOf": [
         {
          "type": "object",
          "properties": {
           "kind": {
            "type": "string",
            "const": "subject.card.create"
           },
           "nodeId": {
            "type": "string",
            "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
           },
           "subjectId": {
            "type": "string",
            "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
           },
           "position": {
            "type": "object",
            "properties": {
             "x": {
              "type": "number"
             },
             "y": {
              "type": "number"
             }
            },
            "required": [
             "x",
             "y"
            ],
            "additionalProperties": false
           }
          },
          "required": [
           "kind",
           "nodeId",
           "subjectId",
           "position"
          ],
          "additionalProperties": false
         },
         {
          "type": "object",
          "properties": {
           "kind": {
            "type": "string",
            "const": "subject.card.delete"
           },
           "nodeId": {
            "type": "string",
            "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
           }
          },
          "required": [
           "kind",
           "nodeId"
          ],
          "additionalProperties": false
         }
        ]
       }
      ]
     }
    },
    "required": [
     "side",
     "operation"
    ],
    "additionalProperties": false
   },
   "referenceIntent": {
    "type": "object",
    "properties": {
     "side": {
      "type": "string",
      "const": "board"
     },
     "operation": {
      "type": "object",
      "properties": {
       "kind": {
        "type": "string",
        "const": "reference-edge"
       },
       "edit": {
        "anyOf": [
         {
          "type": "object",
          "properties": {
           "kind": {
            "type": "string",
            "const": "attach"
           },
           "edgeId": {
            "type": "string",
            "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
           },
           "shotId": {
            "type": "string",
            "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
           },
           "sourceNodeId": {
            "type": "string",
            "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
           },
           "role": {
            "type": "string",
            "enum": [
             "first_frame",
             "last_frame",
             "reference_image",
             "subject_reference",
             "style_reference",
             "composition",
             "reference_audio",
             "reference_video"
            ]
           }
          },
          "required": [
           "kind",
           "edgeId",
           "shotId",
           "sourceNodeId"
          ],
          "additionalProperties": false
         },
         {
          "type": "object",
          "properties": {
           "kind": {
            "type": "string",
            "const": "set-role"
           },
           "edgeId": {
            "type": "string",
            "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
           },
           "shotId": {
            "type": "string",
            "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
           },
           "role": {
            "type": "string",
            "enum": [
             "first_frame",
             "last_frame",
             "reference_image",
             "subject_reference",
             "style_reference",
             "composition",
             "reference_audio",
             "reference_video"
            ]
           }
          },
          "required": [
           "kind",
           "edgeId",
           "shotId",
           "role"
          ],
          "additionalProperties": false
         },
         {
          "type": "object",
          "properties": {
           "kind": {
            "type": "string",
            "const": "detach"
           },
           "edgeId": {
            "type": "string",
            "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
           },
           "shotId": {
            "type": "string",
            "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
           }
          },
          "required": [
           "kind",
           "edgeId",
           "shotId"
          ],
          "additionalProperties": false
         },
         {
          "type": "object",
          "properties": {
           "kind": {
            "type": "string",
            "const": "reorder"
           },
           "shotId": {
            "type": "string",
            "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
           },
           "edgeIds": {
            "type": "array",
            "items": {
             "type": "string",
             "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
            },
            "minItems": 1,
            "maxItems": 48
           }
          },
          "required": [
           "kind",
           "shotId",
           "edgeIds"
          ],
          "additionalProperties": false
         }
        ]
       }
      },
      "required": [
       "kind",
       "edit"
      ],
      "additionalProperties": false
     }
    },
    "required": [
     "side",
     "operation"
    ],
    "additionalProperties": false
   },
   "propertiesIntent": {
    "type": "object",
    "properties": {
     "side": {
      "type": "string",
      "const": "timeline"
     },
     "operation": {
      "type": "object",
      "properties": {
       "kind": {
        "type": "string",
        "const": "clip-properties"
       },
       "edits": {
        "type": "array",
        "items": {
         "type": "object",
         "properties": {
          "clipId": {
           "type": "string",
           "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
          },
          "patch": {
           "type": "object",
           "properties": {
            "transform": {},
            "transition": {},
            "gain": {
             "type": "number",
             "minimum": 0,
             "maximum": 2
            },
            "fadeInFrames": {
             "type": "integer",
             "minimum": 0,
             "maximum": 300000
            },
            "fadeOutFrames": {
             "type": "integer",
             "minimum": 0,
             "maximum": 300000
            },
            "colour": {},
            "audioRole": {},
            "volumeEnvelope": {},
            "name": {
             "type": "string",
             "minLength": 1,
             "maxLength": 200
            },
            "muted": {
             "type": "boolean"
            },
            "sourceReplacement": {
             "type": "object",
             "properties": {
              "assetId": {
               "type": "string",
               "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
              },
              "versionId": {
               "type": "string",
               "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
              }
             },
             "required": [
              "assetId"
             ],
             "additionalProperties": false
            }
           },
           "additionalProperties": false
          }
         },
         "required": [
          "clipId",
          "patch"
         ],
         "additionalProperties": false
        },
        "minItems": 1,
        "maxItems": 100
       }
      },
      "required": [
       "kind",
       "edits"
      ],
      "additionalProperties": false
     }
    },
    "required": [
     "side",
     "operation"
    ],
    "additionalProperties": false
   },
   "previsIntent": {
    "type": "object",
    "properties": {
     "side": {
      "type": "string",
      "const": "board"
     },
     "operation": {
      "anyOf": [
       {
        "type": "object",
        "properties": {
         "kind": {
          "type": "string",
          "const": "previs-create"
         },
         "nodeId": {
          "type": "string",
          "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
         },
         "label": {
          "type": "string",
          "maxLength": 150
         },
         "position": {
          "type": "object",
          "properties": {
           "x": {
            "type": "number"
           },
           "y": {
            "type": "number"
           }
          },
          "required": [
           "x",
           "y"
          ],
          "additionalProperties": false
         }
        },
        "required": [
         "kind",
         "nodeId",
         "label",
         "position"
        ],
        "additionalProperties": false
       },
       {
        "type": "object",
        "properties": {
         "kind": {
          "type": "string",
          "const": "previs-scene-set"
         },
         "nodeId": {
          "type": "string",
          "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
         },
         "expectedSceneRevision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
         },
         "scene": {
          "type": "object",
          "properties": {
           "schemaVersion": {
            "type": "number",
            "const": 1
           },
           "figures": {
            "type": "array",
            "items": {
             "type": "object",
             "properties": {
              "id": {
               "type": "string",
               "pattern": "^f[1-9][0-9]{0,3}$"
              },
              "name": {
               "type": "string",
               "maxLength": 20,
               "pattern": "^[^\\u0000-\\u001f\\u007f-\\u009f\\ud800-\\udfff]*$"
              },
              "visible": {
               "type": "boolean"
              },
              "position": {
               "type": "array",
               "minItems": 3,
               "maxItems": 3,
               "items": [
                {
                 "type": "number",
                 "minimum": -100,
                 "maximum": 100
                },
                {
                 "type": "number",
                 "minimum": -100,
                 "maximum": 100
                },
                {
                 "type": "number",
                 "minimum": -100,
                 "maximum": 100
                }
               ]
              },
              "rotation": {
               "type": "number",
               "minimum": -180,
               "maximum": 180
              },
              "pose": {
               "type": "string",
               "enum": [
                "stand",
                "walk",
                "sit",
                "hold",
                "look-back"
               ]
              },
              "held": {
               "anyOf": [
                {
                 "type": "object",
                 "properties": {
                  "propId": {
                   "type": "string",
                   "pattern": "^p[1-9][0-9]{0,3}$"
                  },
                  "hand": {
                   "type": "string",
                   "enum": [
                    "left",
                    "right"
                   ]
                  }
                 },
                 "required": [
                  "propId",
                  "hand"
                 ],
                 "additionalProperties": false
                },
                {
                 "type": "null"
                }
               ]
              },
              "subject": {
               "type": "object",
               "properties": {
                "subjectId": {
                 "type": "string",
                 "format": "uuid"
                },
                "subjectVersionId": {
                 "type": "string",
                 "format": "uuid"
                }
               },
               "required": [
                "subjectId"
               ],
               "additionalProperties": false
              }
             },
             "required": [
              "id",
              "name",
              "visible",
              "position",
              "rotation",
              "pose",
              "held"
             ],
             "additionalProperties": false
            },
            "maxItems": 8
           },
           "props": {
            "type": "array",
            "items": {
             "type": "object",
             "properties": {
              "id": {
               "type": "string",
               "pattern": "^p[1-9][0-9]{0,3}$"
              },
              "kind": {
               "type": "string",
               "enum": [
                "box",
                "cylinder",
                "sphere",
                "panel",
                "umbrella",
                "phone",
                "bag",
                "cup"
               ]
              },
              "name": {
               "type": "string",
               "maxLength": 20,
               "pattern": "^[^\\u0000-\\u001f\\u007f-\\u009f\\ud800-\\udfff]*$"
              },
              "visible": {
               "type": "boolean"
              },
              "position": {
               "type": "array",
               "minItems": 3,
               "maxItems": 3,
               "items": [
                {
                 "type": "number",
                 "minimum": -100,
                 "maximum": 100
                },
                {
                 "type": "number",
                 "minimum": -100,
                 "maximum": 100
                },
                {
                 "type": "number",
                 "minimum": -100,
                 "maximum": 100
                }
               ]
              },
              "rotation": {
               "type": "number",
               "minimum": -180,
               "maximum": 180
              },
              "size": {
               "type": "array",
               "minItems": 3,
               "maxItems": 3,
               "items": [
                {
                 "type": "number",
                 "minimum": 0.01,
                 "maximum": 20
                },
                {
                 "type": "number",
                 "minimum": 0.01,
                 "maximum": 20
                },
                {
                 "type": "number",
                 "minimum": 0.01,
                 "maximum": 20
                }
               ]
              },
              "subject": {
               "type": "object",
               "properties": {
                "subjectId": {
                 "type": "string",
                 "format": "uuid"
                },
                "subjectVersionId": {
                 "type": "string",
                 "format": "uuid"
                }
               },
               "required": [
                "subjectId"
               ],
               "additionalProperties": false
              }
             },
             "required": [
              "id",
              "kind",
              "name",
              "visible",
              "position",
              "rotation",
              "size"
             ],
             "additionalProperties": false
            },
            "maxItems": 24
           },
           "light": {
            "type": "object",
            "properties": {
             "visible": {
              "type": "boolean"
             },
             "azimuth": {
              "type": "number",
              "minimum": -180,
              "maximum": 180
             },
             "elevation": {
              "type": "number",
              "minimum": -90,
              "maximum": 90
             },
             "intensity": {
              "type": "number",
              "minimum": 0,
              "maximum": 4
             }
            },
            "required": [
             "visible",
             "azimuth",
             "elevation",
             "intensity"
            ],
            "additionalProperties": false
           },
           "camera": {
            "type": "object",
            "properties": {
             "position": {
              "type": "array",
              "minItems": 3,
              "maxItems": 3,
              "items": [
               {
                "type": "number",
                "minimum": -100,
                "maximum": 100
               },
               {
                "type": "number",
                "minimum": -100,
                "maximum": 100
               },
               {
                "type": "number",
                "minimum": -100,
                "maximum": 100
               }
              ]
             },
             "yaw": {
              "type": "number",
              "minimum": -180,
              "maximum": 180
             },
             "pitch": {
              "type": "number",
              "minimum": -90,
              "maximum": 90
             },
             "focalLength": {
              "type": "number",
              "minimum": 10,
              "maximum": 300
             }
            },
            "required": [
             "position",
             "yaw",
             "pitch",
             "focalLength"
            ],
            "additionalProperties": false
           },
           "keyframes": {
            "type": "array",
            "items": {
             "type": "object",
             "properties": {
              "id": {
               "type": "string",
               "pattern": "^k[1-9][0-9]{0,3}$"
              },
              "name": {
               "type": "string",
               "maxLength": 20,
               "pattern": "^[^\\u0000-\\u001f\\u007f-\\u009f\\ud800-\\udfff]*$"
              },
              "camera": {
               "type": "object",
               "properties": {
                "position": {
                 "type": "array",
                 "minItems": 3,
                 "maxItems": 3,
                 "items": [
                  {
                   "type": "number",
                   "minimum": -100,
                   "maximum": 100
                  },
                  {
                   "type": "number",
                   "minimum": -100,
                   "maximum": 100
                  },
                  {
                   "type": "number",
                   "minimum": -100,
                   "maximum": 100
                  }
                 ]
                },
                "yaw": {
                 "type": "number",
                 "minimum": -180,
                 "maximum": 180
                },
                "pitch": {
                 "type": "number",
                 "minimum": -90,
                 "maximum": 90
                },
                "focalLength": {
                 "type": "number",
                 "minimum": 10,
                 "maximum": 300
                }
               },
               "required": [
                "position",
                "yaw",
                "pitch",
                "focalLength"
               ],
               "additionalProperties": false
              },
              "exports": {
               "type": "array",
               "items": {
                "type": "string",
                "format": "uuid"
               },
               "maxItems": 4
              }
             },
             "required": [
              "id",
              "name",
              "camera",
              "exports"
             ],
             "additionalProperties": false
            },
            "maxItems": 24
           },
           "activeKeyframeId": {
            "anyOf": [
             {
              "type": "string",
              "pattern": "^k[1-9][0-9]{0,3}$"
             },
             {
              "type": "null"
             }
            ]
           }
          },
          "required": [
           "schemaVersion",
           "figures",
           "props",
           "light",
           "camera",
           "keyframes",
           "activeKeyframeId"
          ],
          "additionalProperties": false
         }
        },
        "required": [
         "kind",
         "nodeId",
         "expectedSceneRevision",
         "scene"
        ],
        "additionalProperties": false
       }
      ]
     }
    },
    "required": [
     "side",
     "operation"
    ],
    "additionalProperties": false
   },
   "subtitlesIntent": {
    "type": "object",
    "properties": {
     "side": {
      "type": "string",
      "const": "timeline"
     },
     "operation": {
      "type": "object",
      "properties": {
       "kind": {
        "type": "string",
        "const": "subtitles"
       },
       "edits": {
        "type": "array",
        "items": {
         "anyOf": [
          {
           "type": "object",
           "properties": {
            "kind": {
             "type": "string",
             "const": "add"
            },
            "cue": {
             "type": "object",
             "properties": {
              "id": {
               "type": "string",
               "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
              },
              "text": {
               "type": "string",
               "maxLength": 256
              },
              "startFrame": {
               "type": "integer",
               "minimum": 0,
               "maximum": 300000
              },
              "durationFrames": {
               "type": "integer",
               "minimum": 1,
               "maximum": 300000
              },
              "anchor": {
               "anyOf": [
                {
                 "type": "object",
                 "properties": {
                  "clipId": {
                   "type": "string",
                   "format": "uuid"
                  },
                  "offsetFrames": {
                   "type": "integer",
                   "minimum": 0,
                   "maximum": 300000
                  }
                 },
                 "required": [
                  "clipId",
                  "offsetFrames"
                 ],
                 "additionalProperties": false
                },
                {
                 "type": "null"
                }
               ]
              },
              "dialogueRef": {
               "anyOf": [
                {
                 "type": "object",
                 "properties": {
                  "shotId": {
                   "type": "string",
                   "format": "uuid"
                  },
                  "lineId": {
                   "type": "string",
                   "format": "uuid"
                  }
                 },
                 "required": [
                  "shotId",
                  "lineId"
                 ],
                 "additionalProperties": false
                },
                {
                 "type": "null"
                }
               ]
              }
             },
             "required": [
              "id",
              "text",
              "startFrame",
              "durationFrames"
             ],
             "additionalProperties": false
            }
           },
           "required": [
            "kind",
            "cue"
           ],
           "additionalProperties": false
          },
          {
           "type": "object",
           "properties": {
            "kind": {
             "type": "string",
             "const": "update"
            },
            "cueId": {
             "type": "string",
             "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
            },
            "patch": {
             "type": "object",
             "properties": {
              "text": {
               "type": "string",
               "maxLength": 256
              },
              "startFrame": {
               "type": "integer",
               "minimum": 0,
               "maximum": 300000
              },
              "durationFrames": {
               "type": "integer",
               "minimum": 1,
               "maximum": 300000
              },
              "anchor": {
               "anyOf": [
                {
                 "type": "object",
                 "properties": {
                  "clipId": {
                   "type": "string",
                   "format": "uuid"
                  },
                  "offsetFrames": {
                   "type": "integer",
                   "minimum": 0,
                   "maximum": 300000
                  }
                 },
                 "required": [
                  "clipId",
                  "offsetFrames"
                 ],
                 "additionalProperties": false
                },
                {
                 "type": "null"
                }
               ]
              },
              "dialogueRef": {
               "anyOf": [
                {
                 "type": "object",
                 "properties": {
                  "shotId": {
                   "type": "string",
                   "format": "uuid"
                  },
                  "lineId": {
                   "type": "string",
                   "format": "uuid"
                  }
                 },
                 "required": [
                  "shotId",
                  "lineId"
                 ],
                 "additionalProperties": false
                },
                {
                 "type": "null"
                }
               ]
              }
             },
             "additionalProperties": false
            }
           },
           "required": [
            "kind",
            "cueId",
            "patch"
           ],
           "additionalProperties": false
          },
          {
           "type": "object",
           "properties": {
            "kind": {
             "type": "string",
             "const": "remove"
            },
            "cueId": {
             "type": "string",
             "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
            }
           },
           "required": [
            "kind",
            "cueId"
           ],
           "additionalProperties": false
          }
         ]
        },
        "minItems": 1,
        "maxItems": 100
       }
      },
      "required": [
       "kind",
       "edits"
      ],
      "additionalProperties": false
     }
    },
    "required": [
     "side",
     "operation"
    ],
    "additionalProperties": false
   },
   "dialogueIntent": {
    "type": "object",
    "properties": {
     "side": {
      "type": "string",
      "enum": [
       "board",
       "timeline"
      ]
     },
     "operation": {
      "type": "object",
      "properties": {
       "kind": {
        "type": "string",
        "const": "dialogue"
       },
       "edits": {
        "type": "array",
        "items": {
         "anyOf": [
          {
           "type": "object",
           "properties": {
            "kind": {
             "type": "string",
             "const": "add"
            },
            "shotId": {
             "type": "string",
             "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
            },
            "line": {
             "type": "object",
             "properties": {
              "id": {
               "type": "string",
               "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
              },
              "text": {
               "type": "string"
              },
              "speakerSubjectId": {
               "type": "string",
               "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
              }
             },
             "required": [
              "id",
              "text"
             ],
             "additionalProperties": false
            },
            "beforeLineId": {
             "anyOf": [
              {
               "type": "string",
               "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
              },
              {
               "type": "null"
              }
             ]
            }
           },
           "required": [
            "kind",
            "shotId",
            "line"
           ],
           "additionalProperties": false
          },
          {
           "type": "object",
           "properties": {
            "kind": {
             "type": "string",
             "const": "update"
            },
            "shotId": {
             "type": "string",
             "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
            },
            "lineId": {
             "type": "string",
             "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
            },
            "text": {
             "type": "string"
            },
            "speakerSubjectId": {
             "anyOf": [
              {
               "type": "string",
               "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
              },
              {
               "type": "null"
              }
             ]
            }
           },
           "required": [
            "kind",
            "shotId",
            "lineId"
           ],
           "additionalProperties": false
          },
          {
           "type": "object",
           "properties": {
            "kind": {
             "type": "string",
             "const": "remove"
            },
            "shotId": {
             "type": "string",
             "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
            },
            "lineId": {
             "type": "string",
             "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
            }
           },
           "required": [
            "kind",
            "shotId",
            "lineId"
           ],
           "additionalProperties": false
          },
          {
           "type": "object",
           "properties": {
            "kind": {
             "type": "string",
             "const": "reorder"
            },
            "shotId": {
             "type": "string",
             "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
            },
            "lineIds": {
             "type": "array",
             "items": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             },
             "maxItems": 1000
            }
           },
           "required": [
            "kind",
            "shotId",
            "lineIds"
           ],
           "additionalProperties": false
          },
          {
           "type": "object",
           "properties": {
            "kind": {
             "type": "string",
             "const": "set-text-by-cue"
            },
            "cueId": {
             "type": "string",
             "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
            },
            "text": {
             "type": "string"
            }
           },
           "required": [
            "kind",
            "cueId",
            "text"
           ],
           "additionalProperties": false
          }
         ]
        },
        "minItems": 1,
        "maxItems": 100
       }
      },
      "required": [
       "kind",
       "edits"
      ],
      "additionalProperties": false
     }
    },
    "required": [
     "side",
     "operation"
    ],
    "additionalProperties": false
   },
   "trackIntent": {
    "type": "object",
    "properties": {
     "side": {
      "type": "string",
      "const": "timeline"
     },
     "operation": {
      "type": "object",
      "properties": {
       "kind": {
        "type": "string",
        "const": "track-structure"
       },
       "edit": {
        "anyOf": [
         {
          "type": "object",
          "properties": {
           "kind": {
            "type": "string",
            "const": "add"
           },
           "trackId": {
            "type": "string",
            "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
           },
           "trackKind": {
            "type": "string",
            "enum": [
             "video",
             "audio"
            ]
           },
           "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 150
           },
           "orderIndex": {
            "type": "integer",
            "minimum": 0,
            "maximum": 11
           }
          },
          "required": [
           "kind",
           "trackId",
           "trackKind"
          ],
          "additionalProperties": false
         },
         {
          "type": "object",
          "properties": {
           "kind": {
            "type": "string",
            "const": "update"
           },
           "trackId": {
            "type": "string",
            "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
           },
           "patch": {
            "type": "object",
            "properties": {
             "name": {
              "type": "string",
              "minLength": 1,
              "maxLength": 150
             },
             "hidden": {
              "type": "boolean"
             },
             "muted": {
              "type": "boolean"
             },
             "orderIndex": {
              "type": "integer",
              "minimum": 0,
              "maximum": 11
             }
            },
            "additionalProperties": false
           }
          },
          "required": [
           "kind",
           "trackId",
           "patch"
          ],
          "additionalProperties": false
         }
        ]
       }
      },
      "required": [
       "kind",
       "edit"
      ],
      "additionalProperties": false
     }
    },
    "required": [
     "side",
     "operation"
    ],
    "additionalProperties": false
   },
   "soundIntent": {
    "type": "object",
    "properties": {
     "side": {
      "type": "string",
      "const": "timeline"
     },
     "operation": {
      "type": "object",
      "properties": {
       "kind": {
        "type": "string",
        "const": "separate-sound"
       },
       "clipId": {
        "type": "string",
        "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
       },
       "audioClipId": {
        "type": "string",
        "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
       },
       "audioTrackId": {
        "type": "string",
        "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
       },
       "createdTrackId": {
        "type": "string",
        "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
       },
       "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
       },
       "trackName": {
        "type": "string",
        "minLength": 1,
        "maxLength": 150
       }
      },
      "required": [
       "kind",
       "clipId"
      ],
      "additionalProperties": false
     }
    },
    "required": [
     "side",
     "operation"
    ],
    "additionalProperties": false
   },
   "formatIntent": {
    "type": "object",
    "properties": {
     "side": {
      "type": "string",
      "const": "timeline"
     },
     "operation": {
      "type": "object",
      "properties": {
       "kind": {
        "type": "string",
        "const": "timeline-format"
       },
       "presetId": {
        "type": "string",
        "enum": [
         "portrait_1080",
         "landscape_1080",
         "square_1080",
         "portrait_720",
         "landscape_720",
         "square_720"
        ]
       }
      },
      "required": [
       "kind",
       "presetId"
      ],
      "additionalProperties": false
     }
    },
    "required": [
     "side",
     "operation"
    ],
    "additionalProperties": false
   },
   "generateIntent": {
    "type": "object",
    "properties": {
     "side": {
      "type": "string",
      "const": "timeline"
     },
     "operation": {
      "anyOf": [
       {
        "type": "object",
        "properties": {
         "kind": {
          "type": "string",
          "const": "generate-placeholder"
         },
         "placement": {
          "anyOf": [
           {
            "type": "object",
            "properties": {
             "kind": {
              "type": "string",
              "const": "main"
             },
             "beforeClipId": {
              "anyOf": [
               {
                "type": "string",
                "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
               },
               {
                "type": "null"
               }
              ]
             }
            },
            "required": [
             "kind",
             "beforeClipId"
            ],
            "additionalProperties": false
           },
           {
            "type": "object",
            "properties": {
             "kind": {
              "type": "string",
              "const": "track"
             },
             "trackId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             },
             "startFrame": {
              "type": "integer",
              "minimum": 0,
              "maximum": 300000
             }
            },
            "required": [
             "kind",
             "trackId",
             "startFrame"
            ],
            "additionalProperties": false
           }
          ]
         },
         "settings": {
          "type": "object",
          "properties": {
           "providerId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 120
           },
           "model": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
           },
           "region": {
            "type": "string",
            "minLength": 1,
            "maxLength": 120
           },
           "prompt": {
            "type": "string",
            "maxLength": 5000
           },
           "aspectRatio": {
            "type": "string",
            "minLength": 1,
            "maxLength": 40
           },
           "duration": {
            "type": "integer",
            "minimum": 1,
            "maximum": 60
           },
           "parameters": {
            "type": "object",
            "additionalProperties": {}
           },
           "connectionId": {
            "type": "string",
            "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
           },
           "configurationRevision": {
            "type": "integer",
            "minimum": 1,
            "maximum": 9007199254740991
           },
           "modelEntryId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
           }
          },
          "required": [
           "prompt",
           "aspectRatio",
           "duration"
          ],
          "additionalProperties": false
         },
         "shotId": {
          "type": "string",
          "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
         },
         "clipId": {
          "type": "string",
          "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
         },
         "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
         },
         "submit": {
          "type": "boolean"
         },
         "position": {
          "type": "object",
          "properties": {
           "x": {
            "type": "number"
           },
           "y": {
            "type": "number"
           }
          },
          "required": [
           "x",
           "y"
          ],
          "additionalProperties": false
         }
        },
        "required": [
         "kind",
         "placement",
         "settings",
         "shotId",
         "clipId",
         "title"
        ],
        "additionalProperties": false
       },
       {
        "type": "object",
        "properties": {
         "kind": {
          "type": "string",
          "const": "generate-resize"
         },
         "shotId": {
          "type": "string",
          "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
         },
         "duration": {
          "type": "integer",
          "minimum": 1,
          "maximum": 60
         }
        },
        "required": [
         "kind",
         "shotId",
         "duration"
        ],
        "additionalProperties": false
       }
      ]
     }
    },
    "required": [
     "side",
     "operation"
    ],
    "additionalProperties": false
   },
   "allocation": {
    "type": "object",
    "properties": {
     "clips": {
      "type": "array",
      "items": {
       "type": "object",
       "properties": {
        "nodeId": {
         "type": "string",
         "format": "uuid"
        },
        "clipId": {
         "type": "string",
         "format": "uuid"
        }
       },
       "required": [
        "nodeId",
        "clipId"
       ],
       "additionalProperties": false
      },
      "maxItems": 500
     },
     "nodes": {
      "type": "array",
      "items": {
       "type": "object",
       "properties": {
        "fromNodeId": {
         "type": "string",
         "format": "uuid"
        },
        "nodeId": {
         "type": "string",
         "format": "uuid"
        }
       },
       "required": [
        "fromNodeId",
        "nodeId"
       ],
       "additionalProperties": false
      },
      "maxItems": 500
     },
     "splitClips": {
      "type": "array",
      "items": {
       "type": "object",
       "properties": {
        "clipId": {
         "type": "string",
         "format": "uuid"
        },
        "rightClipId": {
         "type": "string",
         "format": "uuid"
        }
       },
       "required": [
        "clipId",
        "rightClipId"
       ],
       "additionalProperties": false
      },
      "maxItems": 500
     },
     "edges": {
      "type": "array",
      "items": {
       "type": "object",
       "properties": {
        "id": {
         "type": "string",
         "format": "uuid"
        },
        "fromId": {
         "type": "string",
         "format": "uuid"
        },
        "toId": {
         "type": "string",
         "format": "uuid"
        }
       },
       "required": [
        "id",
        "fromId",
        "toId"
       ],
       "additionalProperties": false
      },
      "maxItems": 2000
     }
    },
    "additionalProperties": false
   }
  },
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "sequence.commit": {
  "type": "object",
  "properties": {
   "envelope": {
    "type": "object",
    "properties": {
     "contractVersion": {
      "type": "number",
      "const": 1
     },
     "epoch": {
      "type": "string",
      "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
     },
     "actionId": {
      "type": "string",
      "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
     },
     "filmId": {
      "type": "string",
      "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
     },
     "originSide": {
      "type": "string",
      "enum": [
       "board",
       "timeline"
      ]
     },
     "origin": {
      "type": "string",
      "enum": [
       "user",
       "mio"
      ]
     },
     "intents": {
      "type": "array",
      "items": {
       "type": "object",
       "properties": {
        "side": {
         "type": "string",
         "enum": [
          "board",
          "timeline"
         ]
        },
        "operation": {
         "type": "object",
         "properties": {
          "kind": {
           "type": "string",
           "enum": [
            "board",
            "sync-board",
            "board-version",
            "track",
            "board.root.create",
            "board.shot.append",
            "board.layout.move",
            "board.node.create",
            "board.shot.update",
            "board.node.update",
            "board.restore",
            "board.paste",
            "board.duplicate"
           ]
          }
         },
         "required": [
          "kind"
         ],
         "additionalProperties": true
        }
       },
       "required": [
        "side",
        "operation"
       ],
       "additionalProperties": false
      },
      "maxItems": 2
     },
     "subjectIntent": {
      "type": "object",
      "properties": {
       "side": {
        "type": "string",
        "const": "board"
       },
       "operation": {
        "anyOf": [
         {
          "type": "object",
          "properties": {
           "kind": {
            "type": "string",
            "const": "subject-binding"
           },
           "edit": {
            "anyOf": [
             {
              "type": "object",
              "properties": {
               "kind": {
                "type": "string",
                "const": "create"
               },
               "bindingId": {
                "type": "string",
                "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
               },
               "shotId": {
                "type": "string",
                "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
               },
               "subjectId": {
                "type": "string",
                "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
               },
               "role": {
                "type": "string",
                "enum": [
                 "subject",
                 "style"
                ]
               }
              },
              "required": [
               "kind",
               "bindingId",
               "shotId",
               "subjectId",
               "role"
              ],
              "additionalProperties": false
             },
             {
              "type": "object",
              "properties": {
               "kind": {
                "type": "string",
                "const": "set-mode"
               },
               "bindingId": {
                "type": "string",
                "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
               },
               "bindingMode": {
                "type": "string",
                "enum": [
                 "follow",
                 "locked"
                ]
               },
               "subjectVersionId": {
                "anyOf": [
                 {
                  "type": "string",
                  "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
                 },
                 {
                  "type": "null"
                 }
                ]
               }
              },
              "required": [
               "kind",
               "bindingId",
               "bindingMode",
               "subjectVersionId"
              ],
              "additionalProperties": false
             },
             {
              "type": "object",
              "properties": {
               "kind": {
                "type": "string",
                "const": "detach"
               },
               "bindingId": {
                "type": "string",
                "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
               }
              },
              "required": [
               "kind",
               "bindingId"
              ],
              "additionalProperties": false
             },
             {
              "type": "object",
              "properties": {
               "kind": {
                "type": "string",
                "const": "restore"
               },
               "bindingId": {
                "type": "string",
                "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
               },
               "bindingMode": {
                "type": "string",
                "enum": [
                 "follow",
                 "locked"
                ]
               },
               "subjectVersionId": {
                "anyOf": [
                 {
                  "type": "string",
                  "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
                 },
                 {
                  "type": "null"
                 }
                ]
               }
              },
              "required": [
               "kind",
               "bindingId",
               "bindingMode",
               "subjectVersionId"
              ],
              "additionalProperties": false
             }
            ]
           }
          },
          "required": [
           "kind",
           "edit"
          ],
          "additionalProperties": false
         },
         {
          "anyOf": [
           {
            "type": "object",
            "properties": {
             "kind": {
              "type": "string",
              "const": "subject.card.create"
             },
             "nodeId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             },
             "subjectId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             },
             "position": {
              "type": "object",
              "properties": {
               "x": {
                "type": "number"
               },
               "y": {
                "type": "number"
               }
              },
              "required": [
               "x",
               "y"
              ],
              "additionalProperties": false
             }
            },
            "required": [
             "kind",
             "nodeId",
             "subjectId",
             "position"
            ],
            "additionalProperties": false
           },
           {
            "type": "object",
            "properties": {
             "kind": {
              "type": "string",
              "const": "subject.card.delete"
             },
             "nodeId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             }
            },
            "required": [
             "kind",
             "nodeId"
            ],
            "additionalProperties": false
           }
          ]
         }
        ]
       }
      },
      "required": [
       "side",
       "operation"
      ],
      "additionalProperties": false
     },
     "referenceIntent": {
      "type": "object",
      "properties": {
       "side": {
        "type": "string",
        "const": "board"
       },
       "operation": {
        "type": "object",
        "properties": {
         "kind": {
          "type": "string",
          "const": "reference-edge"
         },
         "edit": {
          "anyOf": [
           {
            "type": "object",
            "properties": {
             "kind": {
              "type": "string",
              "const": "attach"
             },
             "edgeId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             },
             "shotId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             },
             "sourceNodeId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             },
             "role": {
              "type": "string",
              "enum": [
               "first_frame",
               "last_frame",
               "reference_image",
               "subject_reference",
               "style_reference",
               "composition",
               "reference_audio",
               "reference_video"
              ]
             }
            },
            "required": [
             "kind",
             "edgeId",
             "shotId",
             "sourceNodeId"
            ],
            "additionalProperties": false
           },
           {
            "type": "object",
            "properties": {
             "kind": {
              "type": "string",
              "const": "set-role"
             },
             "edgeId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             },
             "shotId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             },
             "role": {
              "type": "string",
              "enum": [
               "first_frame",
               "last_frame",
               "reference_image",
               "subject_reference",
               "style_reference",
               "composition",
               "reference_audio",
               "reference_video"
              ]
             }
            },
            "required": [
             "kind",
             "edgeId",
             "shotId",
             "role"
            ],
            "additionalProperties": false
           },
           {
            "type": "object",
            "properties": {
             "kind": {
              "type": "string",
              "const": "detach"
             },
             "edgeId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             },
             "shotId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             }
            },
            "required": [
             "kind",
             "edgeId",
             "shotId"
            ],
            "additionalProperties": false
           },
           {
            "type": "object",
            "properties": {
             "kind": {
              "type": "string",
              "const": "reorder"
             },
             "shotId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             },
             "edgeIds": {
              "type": "array",
              "items": {
               "type": "string",
               "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
              },
              "minItems": 1,
              "maxItems": 48
             }
            },
            "required": [
             "kind",
             "shotId",
             "edgeIds"
            ],
            "additionalProperties": false
           }
          ]
         }
        },
        "required": [
         "kind",
         "edit"
        ],
        "additionalProperties": false
       }
      },
      "required": [
       "side",
       "operation"
      ],
      "additionalProperties": false
     },
     "propertiesIntent": {
      "type": "object",
      "properties": {
       "side": {
        "type": "string",
        "const": "timeline"
       },
       "operation": {
        "type": "object",
        "properties": {
         "kind": {
          "type": "string",
          "const": "clip-properties"
         },
         "edits": {
          "type": "array",
          "items": {
           "type": "object",
           "properties": {
            "clipId": {
             "type": "string",
             "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
            },
            "patch": {
             "type": "object",
             "properties": {
              "transform": {},
              "transition": {},
              "gain": {
               "type": "number",
               "minimum": 0,
               "maximum": 2
              },
              "fadeInFrames": {
               "type": "integer",
               "minimum": 0,
               "maximum": 300000
              },
              "fadeOutFrames": {
               "type": "integer",
               "minimum": 0,
               "maximum": 300000
              },
              "colour": {},
              "audioRole": {},
              "volumeEnvelope": {},
              "name": {
               "type": "string",
               "minLength": 1,
               "maxLength": 200
              },
              "muted": {
               "type": "boolean"
              },
              "sourceReplacement": {
               "type": "object",
               "properties": {
                "assetId": {
                 "type": "string",
                 "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
                },
                "versionId": {
                 "type": "string",
                 "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
                }
               },
               "required": [
                "assetId"
               ],
               "additionalProperties": false
              }
             },
             "additionalProperties": false
            }
           },
           "required": [
            "clipId",
            "patch"
           ],
           "additionalProperties": false
          },
          "minItems": 1,
          "maxItems": 100
         }
        },
        "required": [
         "kind",
         "edits"
        ],
        "additionalProperties": false
       }
      },
      "required": [
       "side",
       "operation"
      ],
      "additionalProperties": false
     },
     "previsIntent": {
      "type": "object",
      "properties": {
       "side": {
        "type": "string",
        "const": "board"
       },
       "operation": {
        "anyOf": [
         {
          "type": "object",
          "properties": {
           "kind": {
            "type": "string",
            "const": "previs-create"
           },
           "nodeId": {
            "type": "string",
            "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
           },
           "label": {
            "type": "string",
            "maxLength": 150
           },
           "position": {
            "type": "object",
            "properties": {
             "x": {
              "type": "number"
             },
             "y": {
              "type": "number"
             }
            },
            "required": [
             "x",
             "y"
            ],
            "additionalProperties": false
           }
          },
          "required": [
           "kind",
           "nodeId",
           "label",
           "position"
          ],
          "additionalProperties": false
         },
         {
          "type": "object",
          "properties": {
           "kind": {
            "type": "string",
            "const": "previs-scene-set"
           },
           "nodeId": {
            "type": "string",
            "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
           },
           "expectedSceneRevision": {
            "type": "integer",
            "minimum": 1,
            "maximum": 9007199254740991
           },
           "scene": {
            "type": "object",
            "properties": {
             "schemaVersion": {
              "type": "number",
              "const": 1
             },
             "figures": {
              "type": "array",
              "items": {
               "type": "object",
               "properties": {
                "id": {
                 "type": "string",
                 "pattern": "^f[1-9][0-9]{0,3}$"
                },
                "name": {
                 "type": "string",
                 "maxLength": 20,
                 "pattern": "^[^\\u0000-\\u001f\\u007f-\\u009f\\ud800-\\udfff]*$"
                },
                "visible": {
                 "type": "boolean"
                },
                "position": {
                 "type": "array",
                 "minItems": 3,
                 "maxItems": 3,
                 "items": [
                  {
                   "type": "number",
                   "minimum": -100,
                   "maximum": 100
                  },
                  {
                   "type": "number",
                   "minimum": -100,
                   "maximum": 100
                  },
                  {
                   "type": "number",
                   "minimum": -100,
                   "maximum": 100
                  }
                 ]
                },
                "rotation": {
                 "type": "number",
                 "minimum": -180,
                 "maximum": 180
                },
                "pose": {
                 "type": "string",
                 "enum": [
                  "stand",
                  "walk",
                  "sit",
                  "hold",
                  "look-back"
                 ]
                },
                "held": {
                 "anyOf": [
                  {
                   "type": "object",
                   "properties": {
                    "propId": {
                     "type": "string",
                     "pattern": "^p[1-9][0-9]{0,3}$"
                    },
                    "hand": {
                     "type": "string",
                     "enum": [
                      "left",
                      "right"
                     ]
                    }
                   },
                   "required": [
                    "propId",
                    "hand"
                   ],
                   "additionalProperties": false
                  },
                  {
                   "type": "null"
                  }
                 ]
                },
                "subject": {
                 "type": "object",
                 "properties": {
                  "subjectId": {
                   "type": "string",
                   "format": "uuid"
                  },
                  "subjectVersionId": {
                   "type": "string",
                   "format": "uuid"
                  }
                 },
                 "required": [
                  "subjectId"
                 ],
                 "additionalProperties": false
                }
               },
               "required": [
                "id",
                "name",
                "visible",
                "position",
                "rotation",
                "pose",
                "held"
               ],
               "additionalProperties": false
              },
              "maxItems": 8
             },
             "props": {
              "type": "array",
              "items": {
               "type": "object",
               "properties": {
                "id": {
                 "type": "string",
                 "pattern": "^p[1-9][0-9]{0,3}$"
                },
                "kind": {
                 "type": "string",
                 "enum": [
                  "box",
                  "cylinder",
                  "sphere",
                  "panel",
                  "umbrella",
                  "phone",
                  "bag",
                  "cup"
                 ]
                },
                "name": {
                 "type": "string",
                 "maxLength": 20,
                 "pattern": "^[^\\u0000-\\u001f\\u007f-\\u009f\\ud800-\\udfff]*$"
                },
                "visible": {
                 "type": "boolean"
                },
                "position": {
                 "type": "array",
                 "minItems": 3,
                 "maxItems": 3,
                 "items": [
                  {
                   "type": "number",
                   "minimum": -100,
                   "maximum": 100
                  },
                  {
                   "type": "number",
                   "minimum": -100,
                   "maximum": 100
                  },
                  {
                   "type": "number",
                   "minimum": -100,
                   "maximum": 100
                  }
                 ]
                },
                "rotation": {
                 "type": "number",
                 "minimum": -180,
                 "maximum": 180
                },
                "size": {
                 "type": "array",
                 "minItems": 3,
                 "maxItems": 3,
                 "items": [
                  {
                   "type": "number",
                   "minimum": 0.01,
                   "maximum": 20
                  },
                  {
                   "type": "number",
                   "minimum": 0.01,
                   "maximum": 20
                  },
                  {
                   "type": "number",
                   "minimum": 0.01,
                   "maximum": 20
                  }
                 ]
                },
                "subject": {
                 "type": "object",
                 "properties": {
                  "subjectId": {
                   "type": "string",
                   "format": "uuid"
                  },
                  "subjectVersionId": {
                   "type": "string",
                   "format": "uuid"
                  }
                 },
                 "required": [
                  "subjectId"
                 ],
                 "additionalProperties": false
                }
               },
               "required": [
                "id",
                "kind",
                "name",
                "visible",
                "position",
                "rotation",
                "size"
               ],
               "additionalProperties": false
              },
              "maxItems": 24
             },
             "light": {
              "type": "object",
              "properties": {
               "visible": {
                "type": "boolean"
               },
               "azimuth": {
                "type": "number",
                "minimum": -180,
                "maximum": 180
               },
               "elevation": {
                "type": "number",
                "minimum": -90,
                "maximum": 90
               },
               "intensity": {
                "type": "number",
                "minimum": 0,
                "maximum": 4
               }
              },
              "required": [
               "visible",
               "azimuth",
               "elevation",
               "intensity"
              ],
              "additionalProperties": false
             },
             "camera": {
              "type": "object",
              "properties": {
               "position": {
                "type": "array",
                "minItems": 3,
                "maxItems": 3,
                "items": [
                 {
                  "type": "number",
                  "minimum": -100,
                  "maximum": 100
                 },
                 {
                  "type": "number",
                  "minimum": -100,
                  "maximum": 100
                 },
                 {
                  "type": "number",
                  "minimum": -100,
                  "maximum": 100
                 }
                ]
               },
               "yaw": {
                "type": "number",
                "minimum": -180,
                "maximum": 180
               },
               "pitch": {
                "type": "number",
                "minimum": -90,
                "maximum": 90
               },
               "focalLength": {
                "type": "number",
                "minimum": 10,
                "maximum": 300
               }
              },
              "required": [
               "position",
               "yaw",
               "pitch",
               "focalLength"
              ],
              "additionalProperties": false
             },
             "keyframes": {
              "type": "array",
              "items": {
               "type": "object",
               "properties": {
                "id": {
                 "type": "string",
                 "pattern": "^k[1-9][0-9]{0,3}$"
                },
                "name": {
                 "type": "string",
                 "maxLength": 20,
                 "pattern": "^[^\\u0000-\\u001f\\u007f-\\u009f\\ud800-\\udfff]*$"
                },
                "camera": {
                 "type": "object",
                 "properties": {
                  "position": {
                   "type": "array",
                   "minItems": 3,
                   "maxItems": 3,
                   "items": [
                    {
                     "type": "number",
                     "minimum": -100,
                     "maximum": 100
                    },
                    {
                     "type": "number",
                     "minimum": -100,
                     "maximum": 100
                    },
                    {
                     "type": "number",
                     "minimum": -100,
                     "maximum": 100
                    }
                   ]
                  },
                  "yaw": {
                   "type": "number",
                   "minimum": -180,
                   "maximum": 180
                  },
                  "pitch": {
                   "type": "number",
                   "minimum": -90,
                   "maximum": 90
                  },
                  "focalLength": {
                   "type": "number",
                   "minimum": 10,
                   "maximum": 300
                  }
                 },
                 "required": [
                  "position",
                  "yaw",
                  "pitch",
                  "focalLength"
                 ],
                 "additionalProperties": false
                },
                "exports": {
                 "type": "array",
                 "items": {
                  "type": "string",
                  "format": "uuid"
                 },
                 "maxItems": 4
                }
               },
               "required": [
                "id",
                "name",
                "camera",
                "exports"
               ],
               "additionalProperties": false
              },
              "maxItems": 24
             },
             "activeKeyframeId": {
              "anyOf": [
               {
                "type": "string",
                "pattern": "^k[1-9][0-9]{0,3}$"
               },
               {
                "type": "null"
               }
              ]
             }
            },
            "required": [
             "schemaVersion",
             "figures",
             "props",
             "light",
             "camera",
             "keyframes",
             "activeKeyframeId"
            ],
            "additionalProperties": false
           }
          },
          "required": [
           "kind",
           "nodeId",
           "expectedSceneRevision",
           "scene"
          ],
          "additionalProperties": false
         }
        ]
       }
      },
      "required": [
       "side",
       "operation"
      ],
      "additionalProperties": false
     },
     "subtitlesIntent": {
      "type": "object",
      "properties": {
       "side": {
        "type": "string",
        "const": "timeline"
       },
       "operation": {
        "type": "object",
        "properties": {
         "kind": {
          "type": "string",
          "const": "subtitles"
         },
         "edits": {
          "type": "array",
          "items": {
           "anyOf": [
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "add"
              },
              "cue": {
               "type": "object",
               "properties": {
                "id": {
                 "type": "string",
                 "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
                },
                "text": {
                 "type": "string",
                 "maxLength": 256
                },
                "startFrame": {
                 "type": "integer",
                 "minimum": 0,
                 "maximum": 300000
                },
                "durationFrames": {
                 "type": "integer",
                 "minimum": 1,
                 "maximum": 300000
                },
                "anchor": {
                 "anyOf": [
                  {
                   "type": "object",
                   "properties": {
                    "clipId": {
                     "type": "string",
                     "format": "uuid"
                    },
                    "offsetFrames": {
                     "type": "integer",
                     "minimum": 0,
                     "maximum": 300000
                    }
                   },
                   "required": [
                    "clipId",
                    "offsetFrames"
                   ],
                   "additionalProperties": false
                  },
                  {
                   "type": "null"
                  }
                 ]
                },
                "dialogueRef": {
                 "anyOf": [
                  {
                   "type": "object",
                   "properties": {
                    "shotId": {
                     "type": "string",
                     "format": "uuid"
                    },
                    "lineId": {
                     "type": "string",
                     "format": "uuid"
                    }
                   },
                   "required": [
                    "shotId",
                    "lineId"
                   ],
                   "additionalProperties": false
                  },
                  {
                   "type": "null"
                  }
                 ]
                }
               },
               "required": [
                "id",
                "text",
                "startFrame",
                "durationFrames"
               ],
               "additionalProperties": false
              }
             },
             "required": [
              "kind",
              "cue"
             ],
             "additionalProperties": false
            },
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "update"
              },
              "cueId": {
               "type": "string",
               "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
              },
              "patch": {
               "type": "object",
               "properties": {
                "text": {
                 "type": "string",
                 "maxLength": 256
                },
                "startFrame": {
                 "type": "integer",
                 "minimum": 0,
                 "maximum": 300000
                },
                "durationFrames": {
                 "type": "integer",
                 "minimum": 1,
                 "maximum": 300000
                },
                "anchor": {
                 "anyOf": [
                  {
                   "type": "object",
                   "properties": {
                    "clipId": {
                     "type": "string",
                     "format": "uuid"
                    },
                    "offsetFrames": {
                     "type": "integer",
                     "minimum": 0,
                     "maximum": 300000
                    }
                   },
                   "required": [
                    "clipId",
                    "offsetFrames"
                   ],
                   "additionalProperties": false
                  },
                  {
                   "type": "null"
                  }
                 ]
                },
                "dialogueRef": {
                 "anyOf": [
                  {
                   "type": "object",
                   "properties": {
                    "shotId": {
                     "type": "string",
                     "format": "uuid"
                    },
                    "lineId": {
                     "type": "string",
                     "format": "uuid"
                    }
                   },
                   "required": [
                    "shotId",
                    "lineId"
                   ],
                   "additionalProperties": false
                  },
                  {
                   "type": "null"
                  }
                 ]
                }
               },
               "additionalProperties": false
              }
             },
             "required": [
              "kind",
              "cueId",
              "patch"
             ],
             "additionalProperties": false
            },
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "remove"
              },
              "cueId": {
               "type": "string",
               "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
              }
             },
             "required": [
              "kind",
              "cueId"
             ],
             "additionalProperties": false
            }
           ]
          },
          "minItems": 1,
          "maxItems": 100
         }
        },
        "required": [
         "kind",
         "edits"
        ],
        "additionalProperties": false
       }
      },
      "required": [
       "side",
       "operation"
      ],
      "additionalProperties": false
     },
     "dialogueIntent": {
      "type": "object",
      "properties": {
       "side": {
        "type": "string",
        "enum": [
         "board",
         "timeline"
        ]
       },
       "operation": {
        "type": "object",
        "properties": {
         "kind": {
          "type": "string",
          "const": "dialogue"
         },
         "edits": {
          "type": "array",
          "items": {
           "anyOf": [
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "add"
              },
              "shotId": {
               "type": "string",
               "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
              },
              "line": {
               "type": "object",
               "properties": {
                "id": {
                 "type": "string",
                 "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
                },
                "text": {
                 "type": "string"
                },
                "speakerSubjectId": {
                 "type": "string",
                 "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
                }
               },
               "required": [
                "id",
                "text"
               ],
               "additionalProperties": false
              },
              "beforeLineId": {
               "anyOf": [
                {
                 "type": "string",
                 "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
                },
                {
                 "type": "null"
                }
               ]
              }
             },
             "required": [
              "kind",
              "shotId",
              "line"
             ],
             "additionalProperties": false
            },
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "update"
              },
              "shotId": {
               "type": "string",
               "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
              },
              "lineId": {
               "type": "string",
               "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
              },
              "text": {
               "type": "string"
              },
              "speakerSubjectId": {
               "anyOf": [
                {
                 "type": "string",
                 "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
                },
                {
                 "type": "null"
                }
               ]
              }
             },
             "required": [
              "kind",
              "shotId",
              "lineId"
             ],
             "additionalProperties": false
            },
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "remove"
              },
              "shotId": {
               "type": "string",
               "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
              },
              "lineId": {
               "type": "string",
               "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
              }
             },
             "required": [
              "kind",
              "shotId",
              "lineId"
             ],
             "additionalProperties": false
            },
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "reorder"
              },
              "shotId": {
               "type": "string",
               "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
              },
              "lineIds": {
               "type": "array",
               "items": {
                "type": "string",
                "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
               },
               "maxItems": 1000
              }
             },
             "required": [
              "kind",
              "shotId",
              "lineIds"
             ],
             "additionalProperties": false
            },
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "set-text-by-cue"
              },
              "cueId": {
               "type": "string",
               "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
              },
              "text": {
               "type": "string"
              }
             },
             "required": [
              "kind",
              "cueId",
              "text"
             ],
             "additionalProperties": false
            }
           ]
          },
          "minItems": 1,
          "maxItems": 100
         }
        },
        "required": [
         "kind",
         "edits"
        ],
        "additionalProperties": false
       }
      },
      "required": [
       "side",
       "operation"
      ],
      "additionalProperties": false
     },
     "trackIntent": {
      "type": "object",
      "properties": {
       "side": {
        "type": "string",
        "const": "timeline"
       },
       "operation": {
        "type": "object",
        "properties": {
         "kind": {
          "type": "string",
          "const": "track-structure"
         },
         "edit": {
          "anyOf": [
           {
            "type": "object",
            "properties": {
             "kind": {
              "type": "string",
              "const": "add"
             },
             "trackId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             },
             "trackKind": {
              "type": "string",
              "enum": [
               "video",
               "audio"
              ]
             },
             "name": {
              "type": "string",
              "minLength": 1,
              "maxLength": 150
             },
             "orderIndex": {
              "type": "integer",
              "minimum": 0,
              "maximum": 11
             }
            },
            "required": [
             "kind",
             "trackId",
             "trackKind"
            ],
            "additionalProperties": false
           },
           {
            "type": "object",
            "properties": {
             "kind": {
              "type": "string",
              "const": "update"
             },
             "trackId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             },
             "patch": {
              "type": "object",
              "properties": {
               "name": {
                "type": "string",
                "minLength": 1,
                "maxLength": 150
               },
               "hidden": {
                "type": "boolean"
               },
               "muted": {
                "type": "boolean"
               },
               "orderIndex": {
                "type": "integer",
                "minimum": 0,
                "maximum": 11
               }
              },
              "additionalProperties": false
             }
            },
            "required": [
             "kind",
             "trackId",
             "patch"
            ],
            "additionalProperties": false
           }
          ]
         }
        },
        "required": [
         "kind",
         "edit"
        ],
        "additionalProperties": false
       }
      },
      "required": [
       "side",
       "operation"
      ],
      "additionalProperties": false
     },
     "soundIntent": {
      "type": "object",
      "properties": {
       "side": {
        "type": "string",
        "const": "timeline"
       },
       "operation": {
        "type": "object",
        "properties": {
         "kind": {
          "type": "string",
          "const": "separate-sound"
         },
         "clipId": {
          "type": "string",
          "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
         },
         "audioClipId": {
          "type": "string",
          "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
         },
         "audioTrackId": {
          "type": "string",
          "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
         },
         "createdTrackId": {
          "type": "string",
          "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
         },
         "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
         },
         "trackName": {
          "type": "string",
          "minLength": 1,
          "maxLength": 150
         }
        },
        "required": [
         "kind",
         "clipId"
        ],
        "additionalProperties": false
       }
      },
      "required": [
       "side",
       "operation"
      ],
      "additionalProperties": false
     },
     "formatIntent": {
      "type": "object",
      "properties": {
       "side": {
        "type": "string",
        "const": "timeline"
       },
       "operation": {
        "type": "object",
        "properties": {
         "kind": {
          "type": "string",
          "const": "timeline-format"
         },
         "presetId": {
          "type": "string",
          "enum": [
           "portrait_1080",
           "landscape_1080",
           "square_1080",
           "portrait_720",
           "landscape_720",
           "square_720"
          ]
         }
        },
        "required": [
         "kind",
         "presetId"
        ],
        "additionalProperties": false
       }
      },
      "required": [
       "side",
       "operation"
      ],
      "additionalProperties": false
     },
     "generateIntent": {
      "type": "object",
      "properties": {
       "side": {
        "type": "string",
        "const": "timeline"
       },
       "operation": {
        "anyOf": [
         {
          "type": "object",
          "properties": {
           "kind": {
            "type": "string",
            "const": "generate-placeholder"
           },
           "placement": {
            "anyOf": [
             {
              "type": "object",
              "properties": {
               "kind": {
                "type": "string",
                "const": "main"
               },
               "beforeClipId": {
                "anyOf": [
                 {
                  "type": "string",
                  "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
                 },
                 {
                  "type": "null"
                 }
                ]
               }
              },
              "required": [
               "kind",
               "beforeClipId"
              ],
              "additionalProperties": false
             },
             {
              "type": "object",
              "properties": {
               "kind": {
                "type": "string",
                "const": "track"
               },
               "trackId": {
                "type": "string",
                "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
               },
               "startFrame": {
                "type": "integer",
                "minimum": 0,
                "maximum": 300000
               }
              },
              "required": [
               "kind",
               "trackId",
               "startFrame"
              ],
              "additionalProperties": false
             }
            ]
           },
           "settings": {
            "type": "object",
            "properties": {
             "providerId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 120
             },
             "model": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
             },
             "region": {
              "type": "string",
              "minLength": 1,
              "maxLength": 120
             },
             "prompt": {
              "type": "string",
              "maxLength": 5000
             },
             "aspectRatio": {
              "type": "string",
              "minLength": 1,
              "maxLength": 40
             },
             "duration": {
              "type": "integer",
              "minimum": 1,
              "maximum": 60
             },
             "parameters": {
              "type": "object",
              "additionalProperties": {}
             },
             "connectionId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             },
             "configurationRevision": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
             },
             "modelEntryId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
             }
            },
            "required": [
             "prompt",
             "aspectRatio",
             "duration"
            ],
            "additionalProperties": false
           },
           "shotId": {
            "type": "string",
            "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
           },
           "clipId": {
            "type": "string",
            "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
           },
           "title": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
           },
           "submit": {
            "type": "boolean"
           },
           "position": {
            "type": "object",
            "properties": {
             "x": {
              "type": "number"
             },
             "y": {
              "type": "number"
             }
            },
            "required": [
             "x",
             "y"
            ],
            "additionalProperties": false
           }
          },
          "required": [
           "kind",
           "placement",
           "settings",
           "shotId",
           "clipId",
           "title"
          ],
          "additionalProperties": false
         },
         {
          "type": "object",
          "properties": {
           "kind": {
            "type": "string",
            "const": "generate-resize"
           },
           "shotId": {
            "type": "string",
            "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
           },
           "duration": {
            "type": "integer",
            "minimum": 1,
            "maximum": 60
           }
          },
          "required": [
           "kind",
           "shotId",
           "duration"
          ],
          "additionalProperties": false
         }
        ]
       }
      },
      "required": [
       "side",
       "operation"
      ],
      "additionalProperties": false
     },
     "baseline": {
      "type": "object",
      "properties": {
       "contentRevision": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
       },
       "timelineRevision": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
       },
       "syncRevision": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
       },
       "historyPosition": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
       },
       "historyRevision": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
       },
       "targets": {
        "type": "array",
        "items": {
         "type": "object",
         "properties": {
          "kind": {
           "type": "string",
           "enum": [
            "shot",
            "node",
            "edge",
            "clip",
            "cue",
            "subject_binding",
            "timeline_track"
           ]
          },
          "id": {
           "type": "string",
           "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
          },
          "revision": {
           "type": "integer",
           "minimum": 1,
           "maximum": 9007199254740991
          }
         },
         "required": [
          "kind",
          "id",
          "revision"
         ],
         "additionalProperties": false
        },
        "maxItems": 2500
       }
      },
      "required": [
       "contentRevision",
       "timelineRevision",
       "syncRevision",
       "historyPosition",
       "historyRevision",
       "targets"
      ],
      "additionalProperties": false
     },
     "impact": {
      "type": "object",
      "properties": {
       "nodeIds": {
        "type": "array",
        "items": {
         "type": "string",
         "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
        },
        "maxItems": 2500
       },
       "edgeIds": {
        "type": "array",
        "items": {
         "type": "string",
         "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
        },
        "maxItems": 2500
       },
       "mainTrackClipIds": {
        "type": "array",
        "items": {
         "type": "string",
         "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
        },
        "maxItems": 2500
       },
       "otherTrackItemIds": {
        "type": "array",
        "items": {
         "type": "string",
         "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
        },
        "maxItems": 2500
       },
       "subtitleCueIds": {
        "type": "array",
        "items": {
         "type": "string",
         "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
        },
        "maxItems": 2500
       },
       "subjectBindingIds": {
        "type": "array",
        "items": {
         "type": "string",
         "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
        },
        "maxItems": 2500
       },
       "trackIds": {
        "type": "array",
        "items": {
         "type": "string",
         "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
        },
        "maxItems": 2500
       }
      },
      "required": [
       "nodeIds",
       "edgeIds",
       "mainTrackClipIds",
       "otherTrackItemIds",
       "subtitleCueIds"
      ],
      "additionalProperties": false
     },
     "allocation": {
      "type": "object",
      "properties": {
       "clips": {
        "type": "array",
        "items": {
         "type": "object",
         "properties": {
          "nodeId": {
           "type": "string",
           "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
          },
          "clipId": {
           "type": "string",
           "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
          }
         },
         "required": [
          "nodeId",
          "clipId"
         ],
         "additionalProperties": false
        },
        "maxItems": 2500
       },
       "nodes": {
        "type": "array",
        "items": {
         "type": "object",
         "properties": {
          "fromNodeId": {
           "type": "string",
           "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
          },
          "nodeId": {
           "type": "string",
           "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
          }
         },
         "required": [
          "fromNodeId",
          "nodeId"
         ],
         "additionalProperties": false
        },
        "maxItems": 2500
       },
       "splitClips": {
        "type": "array",
        "items": {
         "type": "object",
         "properties": {
          "clipId": {
           "type": "string",
           "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
          },
          "rightClipId": {
           "type": "string",
           "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
          }
         },
         "required": [
          "clipId",
          "rightClipId"
         ],
         "additionalProperties": false
        },
        "maxItems": 2500
       },
       "edges": {
        "type": "array",
        "items": {
         "type": "object",
         "properties": {
          "id": {
           "type": "string",
           "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
          },
          "fromId": {
           "type": "string",
           "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
          },
          "toId": {
           "type": "string",
           "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
          }
         },
         "required": [
          "id",
          "fromId",
          "toId"
         ],
         "additionalProperties": false
        },
        "maxItems": 2500
       }
      },
      "required": [
       "clips",
       "nodes",
       "splitClips",
       "edges"
      ],
      "additionalProperties": false
     }
    },
    "required": [
     "contractVersion",
     "epoch",
     "actionId",
     "filmId",
     "originSide",
     "intents",
     "baseline",
     "impact",
     "allocation"
    ],
    "additionalProperties": false
   },
   "expectedPlanDigest": {
    "type": "string",
    "pattern": "^[a-f0-9]{64}$"
   }
  },
  "required": [
   "envelope",
   "expectedPlanDigest"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "sequence.history.get": {
  "type": "object",
  "properties": {
   "origin": {
    "type": "string",
    "enum": [
     "user",
     "mio"
    ]
   }
  },
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "sequence.undo": {
  "type": "object",
  "properties": {
   "actionId": {
    "type": "string",
    "format": "uuid"
   },
   "expected": {
    "type": "object",
    "properties": {
     "position": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
     },
     "revision": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
     }
    },
    "required": [
     "position",
     "revision"
    ],
    "additionalProperties": false
   },
   "origin": {
    "type": "string",
    "enum": [
     "user",
     "mio"
    ]
   }
  },
  "required": [
   "actionId",
   "expected"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "sequence.redo": {
  "type": "object",
  "properties": {
   "actionId": {
    "type": "string",
    "format": "uuid"
   },
   "expected": {
    "type": "object",
    "properties": {
     "position": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
     },
     "revision": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
     }
    },
    "required": [
     "position",
     "revision"
    ],
    "additionalProperties": false
   },
   "origin": {
    "type": "string",
    "enum": [
     "user",
     "mio"
    ]
   }
  },
  "required": [
   "actionId",
   "expected"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "sequence.board.get": {
  "type": "object",
  "properties": {},
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "sequence.action.edit": {
  "anyOf": [
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "connect"
     },
     "fromId": {
      "type": "string",
      "format": "uuid"
     },
     "toId": {
      "type": "string",
      "format": "uuid"
     }
    },
    "required": [
     "kind",
     "fromId",
     "toId"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "disconnect"
     },
     "fromId": {
      "type": "string",
      "format": "uuid"
     },
     "toId": {
      "type": "string",
      "format": "uuid"
     }
    },
    "required": [
     "kind",
     "fromId",
     "toId"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "insert"
     },
     "fromId": {
      "type": "string",
      "format": "uuid"
     },
     "toId": {
      "type": "string",
      "format": "uuid"
     },
     "nodeId": {
      "type": "string",
      "format": "uuid"
     }
    },
    "required": [
     "kind",
     "fromId",
     "toId",
     "nodeId"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "delete-node"
     },
     "nodeId": {
      "type": "string",
      "format": "uuid"
     }
    },
    "required": [
     "kind",
     "nodeId"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "reorder"
     },
     "clipId": {
      "type": "string",
      "format": "uuid"
     },
     "beforeClipId": {
      "anyOf": [
       {
        "type": "string",
        "format": "uuid"
       },
       {
        "type": "null"
       }
      ]
     }
    },
    "required": [
     "kind",
     "clipId",
     "beforeClipId"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "remove"
     },
     "clipId": {
      "type": "string",
      "format": "uuid"
     }
    },
    "required": [
     "kind",
     "clipId"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "split"
     },
     "clipId": {
      "type": "string",
      "format": "uuid"
     },
     "offsetFrames": {
      "type": "integer",
      "minimum": 1,
      "maximum": 18000
     }
    },
    "required": [
     "kind",
     "clipId",
     "offsetFrames"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "set-mode"
     },
     "clipId": {
      "type": "string",
      "format": "uuid"
     },
     "mode": {
      "type": "string",
      "enum": [
       "follow",
       "locked"
      ]
     },
     "versionId": {
      "anyOf": [
       {
        "type": "string",
        "format": "uuid"
       },
       {
        "type": "null"
       }
      ]
     }
    },
    "required": [
     "kind",
     "clipId",
     "mode"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "copy-move"
     },
     "clipId": {
      "type": "string",
      "format": "uuid"
     },
     "beforeClipId": {
      "anyOf": [
       {
        "type": "string",
        "format": "uuid"
       },
       {
        "type": "null"
       }
      ]
     }
    },
    "required": [
     "kind",
     "clipId",
     "beforeClipId"
    ],
    "additionalProperties": false
   }
  ],
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object"
 },
 "sequence.board.edit": {
  "anyOf": [
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "board-root-create"
     },
     "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
     },
     "position": {
      "type": "object",
      "properties": {
       "x": {
        "type": "number",
        "minimum": -1000000,
        "maximum": 1000000
       },
       "y": {
        "type": "number",
        "minimum": -1000000,
        "maximum": 1000000
       }
      },
      "required": [
       "x",
       "y"
      ],
      "additionalProperties": false
     }
    },
    "required": [
     "kind",
     "name",
     "position"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "board-shot-append"
     },
     "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
     },
     "position": {
      "type": "object",
      "properties": {
       "x": {
        "type": "number",
        "minimum": -1000000,
        "maximum": 1000000
       },
       "y": {
        "type": "number",
        "minimum": -1000000,
        "maximum": 1000000
       }
      },
      "required": [
       "x",
       "y"
      ],
      "additionalProperties": false
     }
    },
    "required": [
     "kind",
     "name"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "board-layout-move"
     },
     "moves": {
      "type": "array",
      "items": {
       "type": "object",
       "properties": {
        "nodeId": {
         "type": "string",
         "format": "uuid"
        },
        "x": {
         "type": "number",
         "minimum": -1000000,
         "maximum": 1000000
        },
        "y": {
         "type": "number",
         "minimum": -1000000,
         "maximum": 1000000
        }
       },
       "required": [
        "nodeId",
        "x",
        "y"
       ],
       "additionalProperties": false
      },
      "minItems": 1,
      "maxItems": 50
     }
    },
    "required": [
     "kind",
     "moves"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "board-node-create"
     },
     "type": {
      "type": "string",
      "enum": [
       "image",
       "video",
       "audio",
       "text"
      ]
     },
     "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 150
     },
     "position": {
      "type": "object",
      "properties": {
       "x": {
        "type": "number",
        "minimum": -1000000,
        "maximum": 1000000
       },
       "y": {
        "type": "number",
        "minimum": -1000000,
        "maximum": 1000000
       }
      },
      "required": [
       "x",
       "y"
      ],
      "additionalProperties": false
     },
     "assetId": {
      "type": "string",
      "format": "uuid"
     },
     "text": {
      "type": "string",
      "maxLength": 5000
     }
    },
    "required": [
     "kind",
     "type",
     "name",
     "position"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "board-shot-update"
     },
     "shotId": {
      "type": "string",
      "format": "uuid"
     },
     "expectedRevision": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
     },
     "patch": {
      "type": "object",
      "properties": {
       "title": {
        "type": "string",
        "minLength": 1,
        "maxLength": 500
       },
       "prompt": {
        "type": "string",
        "maxLength": 20000
       },
       "duration": {
        "type": "number",
        "minimum": 0.05,
        "maximum": 600
       },
       "aspectRatio": {
        "type": "string",
        "enum": [
         "9:16",
         "16:9"
        ]
       },
       "position": {
        "type": "object",
        "properties": {
         "x": {
          "type": "number",
          "minimum": -1000000,
          "maximum": 1000000
         },
         "y": {
          "type": "number",
          "minimum": -1000000,
          "maximum": 1000000
         }
        },
        "required": [
         "x",
         "y"
        ],
        "additionalProperties": false
       }
      },
      "additionalProperties": false
     }
    },
    "required": [
     "kind",
     "shotId",
     "expectedRevision",
     "patch"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "board-node-update"
     },
     "nodeId": {
      "type": "string",
      "format": "uuid"
     },
     "expectedRevision": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
     },
     "patch": {
      "type": "object",
      "properties": {
       "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 150
       },
       "text": {
        "type": "string",
        "maxLength": 5000
       },
       "position": {
        "type": "object",
        "properties": {
         "x": {
          "type": "number",
          "minimum": -1000000,
          "maximum": 1000000
         },
         "y": {
          "type": "number",
          "minimum": -1000000,
          "maximum": 1000000
         }
        },
        "required": [
         "x",
         "y"
        ],
        "additionalProperties": false
       }
      },
      "additionalProperties": false
     }
    },
    "required": [
     "kind",
     "nodeId",
     "expectedRevision",
     "patch"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "board-restore"
     },
     "targets": {
      "type": "array",
      "items": {
       "type": "object",
       "properties": {
        "kind": {
         "type": "string",
         "enum": [
          "shot",
          "node"
         ]
        },
        "id": {
         "type": "string",
         "format": "uuid"
        }
       },
       "required": [
        "kind",
        "id"
       ],
       "additionalProperties": false
      },
      "minItems": 1,
      "maxItems": 50
     }
    },
    "required": [
     "kind",
     "targets"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "board-duplicate"
     },
     "targets": {
      "type": "array",
      "items": {
       "type": "object",
       "properties": {
        "kind": {
         "type": "string",
         "enum": [
          "shot",
          "node"
         ]
        },
        "id": {
         "type": "string",
         "format": "uuid"
        }
       },
       "required": [
        "kind",
        "id"
       ],
       "additionalProperties": false
      },
      "minItems": 1,
      "maxItems": 50
     },
     "viewport": {
      "type": "object",
      "properties": {
       "x": {
        "type": "number"
       },
       "y": {
        "type": "number"
       },
       "width": {
        "type": "number",
        "exclusiveMinimum": 0
       },
       "height": {
        "type": "number",
        "exclusiveMinimum": 0
       }
      },
      "required": [
       "x",
       "y",
       "width",
       "height"
      ],
      "additionalProperties": false
     }
    },
    "required": [
     "kind",
     "targets"
    ],
    "additionalProperties": false
   }
  ],
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object"
 },
 "sequence.reference.edit": {
  "anyOf": [
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "reference-attach"
     },
     "sourceNodeId": {
      "type": "string",
      "format": "uuid"
     },
     "shotId": {
      "type": "string",
      "format": "uuid"
     },
     "role": {
      "type": "string",
      "enum": [
       "first_frame",
       "last_frame",
       "reference_image",
       "composition",
       "reference_audio",
       "reference_video",
       "subject_reference",
       "style_reference"
      ]
     }
    },
    "required": [
     "kind",
     "sourceNodeId",
     "shotId"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "reference-set-role"
     },
     "edgeId": {
      "type": "string",
      "format": "uuid"
     },
     "shotId": {
      "type": "string",
      "format": "uuid"
     },
     "role": {
      "type": "string",
      "enum": [
       "first_frame",
       "last_frame",
       "reference_image",
       "composition",
       "reference_audio",
       "reference_video",
       "subject_reference",
       "style_reference"
      ]
     }
    },
    "required": [
     "kind",
     "edgeId",
     "shotId",
     "role"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "reference-detach"
     },
     "edgeId": {
      "type": "string",
      "format": "uuid"
     },
     "shotId": {
      "type": "string",
      "format": "uuid"
     }
    },
    "required": [
     "kind",
     "edgeId",
     "shotId"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "reference-reorder"
     },
     "shotId": {
      "type": "string",
      "format": "uuid"
     },
     "edgeIds": {
      "type": "array",
      "items": {
       "type": "string",
       "format": "uuid"
      },
      "minItems": 1,
      "maxItems": 48
     }
    },
    "required": [
     "kind",
     "shotId",
     "edgeIds"
    ],
    "additionalProperties": false
   }
  ],
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object"
 },
 "sequence.subject.edit": {
  "anyOf": [
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "subject-binding"
     },
     "edit": {
      "anyOf": [
       {
        "type": "object",
        "properties": {
         "kind": {
          "type": "string",
          "const": "create"
         },
         "shotId": {
          "type": "string",
          "format": "uuid"
         },
         "subjectId": {
          "type": "string",
          "format": "uuid"
         },
         "role": {
          "type": "string",
          "enum": [
           "subject",
           "style"
          ]
         }
        },
        "required": [
         "kind",
         "shotId",
         "subjectId",
         "role"
        ],
        "additionalProperties": false
       },
       {
        "type": "object",
        "properties": {
         "kind": {
          "type": "string",
          "const": "set-mode"
         },
         "bindingId": {
          "type": "string",
          "format": "uuid"
         },
         "bindingMode": {
          "type": "string",
          "enum": [
           "follow",
           "locked"
          ]
         },
         "subjectVersionId": {
          "anyOf": [
           {
            "type": "string",
            "format": "uuid"
           },
           {
            "type": "null"
           }
          ]
         }
        },
        "required": [
         "kind",
         "bindingId",
         "bindingMode",
         "subjectVersionId"
        ],
        "additionalProperties": false
       },
       {
        "type": "object",
        "properties": {
         "kind": {
          "type": "string",
          "const": "detach"
         },
         "bindingId": {
          "type": "string",
          "format": "uuid"
         }
        },
        "required": [
         "kind",
         "bindingId"
        ],
        "additionalProperties": false
       },
       {
        "type": "object",
        "properties": {
         "kind": {
          "type": "string",
          "const": "restore"
         },
         "bindingId": {
          "type": "string",
          "format": "uuid"
         },
         "bindingMode": {
          "type": "string",
          "enum": [
           "follow",
           "locked"
          ]
         },
         "subjectVersionId": {
          "anyOf": [
           {
            "type": "string",
            "format": "uuid"
           },
           {
            "type": "null"
           }
          ]
         }
        },
        "required": [
         "kind",
         "bindingId",
         "bindingMode",
         "subjectVersionId"
        ],
        "additionalProperties": false
       }
      ]
     }
    },
    "required": [
     "kind",
     "edit"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "subject-card-create"
     },
     "subjectId": {
      "type": "string",
      "format": "uuid"
     },
     "position": {
      "type": "object",
      "properties": {
       "x": {
        "type": "number",
        "minimum": -1000000,
        "maximum": 1000000
       },
       "y": {
        "type": "number",
        "minimum": -1000000,
        "maximum": 1000000
       }
      },
      "required": [
       "x",
       "y"
      ],
      "additionalProperties": false
     }
    },
    "required": [
     "kind",
     "subjectId"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "subject-card-delete"
     },
     "nodeId": {
      "type": "string",
      "format": "uuid"
     }
    },
    "required": [
     "kind",
     "nodeId"
    ],
    "additionalProperties": false
   }
  ],
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object"
 },
 "sequence.previs.edit": {
  "anyOf": [
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "previs-create"
     },
     "label": {
      "type": "string",
      "maxLength": 150
     },
     "position": {
      "type": "object",
      "properties": {
       "x": {
        "type": "number",
        "minimum": -1000000,
        "maximum": 1000000
       },
       "y": {
        "type": "number",
        "minimum": -1000000,
        "maximum": 1000000
       }
      },
      "required": [
       "x",
       "y"
      ],
      "additionalProperties": false
     }
    },
    "required": [
     "kind",
     "label"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "previs-scene-set"
     },
     "nodeId": {
      "type": "string",
      "format": "uuid"
     },
     "expectedSceneRevision": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
     },
     "scene": {
      "type": "object",
      "properties": {
       "schemaVersion": {
        "type": "number",
        "const": 1
       },
       "figures": {
        "type": "array",
        "items": {
         "type": "object",
         "properties": {
          "id": {
           "type": "string",
           "pattern": "^f[1-9][0-9]{0,3}$"
          },
          "name": {
           "type": "string",
           "maxLength": 20,
           "pattern": "^[^\\u0000-\\u001f\\u007f-\\u009f\\ud800-\\udfff]*$"
          },
          "visible": {
           "type": "boolean"
          },
          "position": {
           "type": "array",
           "minItems": 3,
           "maxItems": 3,
           "items": [
            {
             "type": "number",
             "minimum": -100,
             "maximum": 100
            },
            {
             "type": "number",
             "minimum": -100,
             "maximum": 100
            },
            {
             "type": "number",
             "minimum": -100,
             "maximum": 100
            }
           ]
          },
          "rotation": {
           "type": "number",
           "minimum": -180,
           "maximum": 180
          },
          "pose": {
           "type": "string",
           "enum": [
            "stand",
            "walk",
            "sit",
            "hold",
            "look-back"
           ]
          },
          "held": {
           "anyOf": [
            {
             "type": "object",
             "properties": {
              "propId": {
               "type": "string",
               "pattern": "^p[1-9][0-9]{0,3}$"
              },
              "hand": {
               "type": "string",
               "enum": [
                "left",
                "right"
               ]
              }
             },
             "required": [
              "propId",
              "hand"
             ],
             "additionalProperties": false
            },
            {
             "type": "null"
            }
           ]
          },
          "subject": {
           "type": "object",
           "properties": {
            "subjectId": {
             "type": "string",
             "format": "uuid"
            },
            "subjectVersionId": {
             "type": "string",
             "format": "uuid"
            }
           },
           "required": [
            "subjectId"
           ],
           "additionalProperties": false
          }
         },
         "required": [
          "id",
          "name",
          "visible",
          "position",
          "rotation",
          "pose",
          "held"
         ],
         "additionalProperties": false
        },
        "maxItems": 8
       },
       "props": {
        "type": "array",
        "items": {
         "type": "object",
         "properties": {
          "id": {
           "type": "string",
           "pattern": "^p[1-9][0-9]{0,3}$"
          },
          "kind": {
           "type": "string",
           "enum": [
            "box",
            "cylinder",
            "sphere",
            "panel",
            "umbrella",
            "phone",
            "bag",
            "cup"
           ]
          },
          "name": {
           "type": "string",
           "maxLength": 20,
           "pattern": "^[^\\u0000-\\u001f\\u007f-\\u009f\\ud800-\\udfff]*$"
          },
          "visible": {
           "type": "boolean"
          },
          "position": {
           "type": "array",
           "minItems": 3,
           "maxItems": 3,
           "items": [
            {
             "type": "number",
             "minimum": -100,
             "maximum": 100
            },
            {
             "type": "number",
             "minimum": -100,
             "maximum": 100
            },
            {
             "type": "number",
             "minimum": -100,
             "maximum": 100
            }
           ]
          },
          "rotation": {
           "type": "number",
           "minimum": -180,
           "maximum": 180
          },
          "size": {
           "type": "array",
           "minItems": 3,
           "maxItems": 3,
           "items": [
            {
             "type": "number",
             "minimum": 0.01,
             "maximum": 20
            },
            {
             "type": "number",
             "minimum": 0.01,
             "maximum": 20
            },
            {
             "type": "number",
             "minimum": 0.01,
             "maximum": 20
            }
           ]
          },
          "subject": {
           "type": "object",
           "properties": {
            "subjectId": {
             "type": "string",
             "format": "uuid"
            },
            "subjectVersionId": {
             "type": "string",
             "format": "uuid"
            }
           },
           "required": [
            "subjectId"
           ],
           "additionalProperties": false
          }
         },
         "required": [
          "id",
          "kind",
          "name",
          "visible",
          "position",
          "rotation",
          "size"
         ],
         "additionalProperties": false
        },
        "maxItems": 24
       },
       "light": {
        "type": "object",
        "properties": {
         "visible": {
          "type": "boolean"
         },
         "azimuth": {
          "type": "number",
          "minimum": -180,
          "maximum": 180
         },
         "elevation": {
          "type": "number",
          "minimum": -90,
          "maximum": 90
         },
         "intensity": {
          "type": "number",
          "minimum": 0,
          "maximum": 4
         }
        },
        "required": [
         "visible",
         "azimuth",
         "elevation",
         "intensity"
        ],
        "additionalProperties": false
       },
       "camera": {
        "type": "object",
        "properties": {
         "position": {
          "type": "array",
          "minItems": 3,
          "maxItems": 3,
          "items": [
           {
            "type": "number",
            "minimum": -100,
            "maximum": 100
           },
           {
            "type": "number",
            "minimum": -100,
            "maximum": 100
           },
           {
            "type": "number",
            "minimum": -100,
            "maximum": 100
           }
          ]
         },
         "yaw": {
          "type": "number",
          "minimum": -180,
          "maximum": 180
         },
         "pitch": {
          "type": "number",
          "minimum": -90,
          "maximum": 90
         },
         "focalLength": {
          "type": "number",
          "minimum": 10,
          "maximum": 300
         }
        },
        "required": [
         "position",
         "yaw",
         "pitch",
         "focalLength"
        ],
        "additionalProperties": false
       },
       "keyframes": {
        "type": "array",
        "items": {
         "type": "object",
         "properties": {
          "id": {
           "type": "string",
           "pattern": "^k[1-9][0-9]{0,3}$"
          },
          "name": {
           "type": "string",
           "maxLength": 20,
           "pattern": "^[^\\u0000-\\u001f\\u007f-\\u009f\\ud800-\\udfff]*$"
          },
          "camera": {
           "type": "object",
           "properties": {
            "position": {
             "type": "array",
             "minItems": 3,
             "maxItems": 3,
             "items": [
              {
               "type": "number",
               "minimum": -100,
               "maximum": 100
              },
              {
               "type": "number",
               "minimum": -100,
               "maximum": 100
              },
              {
               "type": "number",
               "minimum": -100,
               "maximum": 100
              }
             ]
            },
            "yaw": {
             "type": "number",
             "minimum": -180,
             "maximum": 180
            },
            "pitch": {
             "type": "number",
             "minimum": -90,
             "maximum": 90
            },
            "focalLength": {
             "type": "number",
             "minimum": 10,
             "maximum": 300
            }
           },
           "required": [
            "position",
            "yaw",
            "pitch",
            "focalLength"
           ],
           "additionalProperties": false
          },
          "exports": {
           "type": "array",
           "items": {
            "type": "string",
            "format": "uuid"
           },
           "maxItems": 4
          }
         },
         "required": [
          "id",
          "name",
          "camera",
          "exports"
         ],
         "additionalProperties": false
        },
        "maxItems": 24
       },
       "activeKeyframeId": {
        "anyOf": [
         {
          "type": "string",
          "pattern": "^k[1-9][0-9]{0,3}$"
         },
         {
          "type": "null"
         }
        ]
       }
      },
      "required": [
       "schemaVersion",
       "figures",
       "props",
       "light",
       "camera",
       "keyframes",
       "activeKeyframeId"
      ],
      "additionalProperties": false
     }
    },
    "required": [
     "kind",
     "nodeId",
     "expectedSceneRevision",
     "scene"
    ],
    "additionalProperties": false
   }
  ],
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object"
 },
 "sequence.timeline.edit": {
  "anyOf": [
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "dialogue"
     },
     "shotId": {
      "type": "string",
      "format": "uuid"
     },
     "edits": {
      "type": "array",
      "items": {
       "anyOf": [
        {
         "type": "object",
         "properties": {
          "kind": {
           "type": "string",
           "const": "add"
          },
          "text": {
           "type": "string",
           "minLength": 1,
           "maxLength": 81
          },
          "speakerSubjectId": {
           "anyOf": [
            {
             "type": "string",
             "format": "uuid"
            },
            {
             "type": "null"
            }
           ]
          },
          "beforeLineId": {
           "type": "string",
           "format": "uuid"
          }
         },
         "required": [
          "kind",
          "text"
         ],
         "additionalProperties": false
        },
        {
         "type": "object",
         "properties": {
          "kind": {
           "type": "string",
           "const": "update"
          },
          "lineId": {
           "type": "string",
           "format": "uuid"
          },
          "text": {
           "type": "string",
           "minLength": 1,
           "maxLength": 81
          },
          "speakerSubjectId": {
           "anyOf": [
            {
             "type": "string",
             "format": "uuid"
            },
            {
             "type": "null"
            }
           ]
          }
         },
         "required": [
          "kind",
          "lineId"
         ],
         "additionalProperties": false
        },
        {
         "type": "object",
         "properties": {
          "kind": {
           "type": "string",
           "const": "remove"
          },
          "lineId": {
           "type": "string",
           "format": "uuid"
          }
         },
         "required": [
          "kind",
          "lineId"
         ],
         "additionalProperties": false
        },
        {
         "type": "object",
         "properties": {
          "kind": {
           "type": "string",
           "const": "reorder"
          },
          "lineIds": {
           "type": "array",
           "items": {
            "type": "string",
            "format": "uuid"
           },
           "minItems": 1,
           "maxItems": 100
          }
         },
         "required": [
          "kind",
          "lineIds"
         ],
         "additionalProperties": false
        }
       ]
      },
      "minItems": 1,
      "maxItems": 30
     }
    },
    "required": [
     "kind",
     "shotId",
     "edits"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "subtitles"
     },
     "edits": {
      "type": "array",
      "items": {
       "anyOf": [
        {
         "type": "object",
         "properties": {
          "kind": {
           "type": "string",
           "const": "add"
          },
          "cue": {
           "type": "object",
           "properties": {
            "text": {
             "type": "string",
             "maxLength": 256
            },
            "startFrame": {
             "type": "integer",
             "minimum": 0,
             "maximum": 300000
            },
            "durationFrames": {
             "type": "integer",
             "minimum": 1,
             "maximum": 300000
            },
            "anchor": {},
            "dialogueRef": {}
           },
           "required": [
            "text",
            "startFrame",
            "durationFrames"
           ],
           "additionalProperties": false
          }
         },
         "required": [
          "kind",
          "cue"
         ],
         "additionalProperties": false
        },
        {
         "type": "object",
         "properties": {
          "kind": {
           "type": "string",
           "const": "update"
          },
          "cueId": {
           "type": "string",
           "format": "uuid"
          },
          "patch": {
           "type": "object",
           "additionalProperties": {}
          }
         },
         "required": [
          "kind",
          "cueId",
          "patch"
         ],
         "additionalProperties": false
        },
        {
         "type": "object",
         "properties": {
          "kind": {
           "type": "string",
           "const": "remove"
          },
          "cueId": {
           "type": "string",
           "format": "uuid"
          }
         },
         "required": [
          "kind",
          "cueId"
         ],
         "additionalProperties": false
        }
       ]
      },
      "minItems": 1,
      "maxItems": 100
     }
    },
    "required": [
     "kind",
     "edits"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "format-set"
     },
     "presetId": {
      "type": "string",
      "enum": [
       "portrait_1080",
       "landscape_1080",
       "square_1080",
       "portrait_720",
       "landscape_720",
       "square_720"
      ]
     }
    },
    "required": [
     "kind",
     "presetId"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "split-at-scenes"
     },
     "assetId": {
      "type": "string",
      "format": "uuid"
     },
     "resultId": {
      "type": "string",
      "format": "uuid"
     }
    },
    "required": [
     "kind",
     "assetId",
     "resultId"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "separate-sound"
     },
     "clipId": {
      "type": "string",
      "format": "uuid"
     }
    },
    "required": [
     "kind",
     "clipId"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "generate"
     },
     "placement": {
      "anyOf": [
       {
        "type": "object",
        "properties": {
         "kind": {
          "type": "string",
          "const": "main"
         },
         "beforeClipId": {
          "anyOf": [
           {
            "type": "string",
            "format": "uuid"
           },
           {
            "type": "null"
           }
          ]
         }
        },
        "required": [
         "kind",
         "beforeClipId"
        ],
        "additionalProperties": false
       },
       {
        "type": "object",
        "properties": {
         "kind": {
          "type": "string",
          "const": "track"
         },
         "trackId": {
          "type": "string",
          "format": "uuid"
         },
         "startFrame": {
          "type": "integer",
          "minimum": 0,
          "maximum": 300000
         }
        },
        "required": [
         "kind",
         "trackId",
         "startFrame"
        ],
        "additionalProperties": false
       }
      ]
     },
     "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
     },
     "providerId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
     },
     "model": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
     },
     "region": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
     },
     "prompt": {
      "type": "string",
      "maxLength": 5000
     },
     "aspectRatio": {
      "type": "string",
      "minLength": 1,
      "maxLength": 40
     },
     "duration": {
      "type": "integer",
      "minimum": 1,
      "maximum": 60
     },
     "parameters": {
      "type": "object",
      "additionalProperties": {}
     },
     "connectionId": {
      "type": "string",
      "format": "uuid"
     },
     "configurationRevision": {
      "type": "integer",
      "minimum": 1
     },
     "modelEntryId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
     }
    },
    "required": [
     "kind",
     "placement",
     "providerId",
     "model",
     "region",
     "prompt",
     "aspectRatio",
     "duration"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "insert-asset"
     },
     "assetId": {
      "type": "string",
      "format": "uuid"
     },
     "trackId": {
      "anyOf": [
       {
        "type": "string",
        "format": "uuid"
       },
       {
        "type": "null"
       }
      ]
     },
     "startFrame": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
     }
    },
    "required": [
     "kind",
     "assetId",
     "trackId",
     "startFrame"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "track-add"
     },
     "trackKind": {
      "type": "string",
      "enum": [
       "video",
       "audio"
      ]
     },
     "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 150
     }
    },
    "required": [
     "kind",
     "trackKind"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "track-update"
     },
     "trackId": {
      "type": "string",
      "format": "uuid"
     },
     "patch": {
      "type": "object",
      "properties": {
       "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 150
       },
       "hidden": {
        "type": "boolean"
       },
       "muted": {
        "type": "boolean"
       },
       "orderIndex": {
        "type": "integer",
        "minimum": 0,
        "maximum": 11
       }
      },
      "additionalProperties": false
     }
    },
    "required": [
     "kind",
     "trackId",
     "patch"
    ],
    "additionalProperties": false
   }
  ],
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object"
 },
 "sequence.clip.edit": {
  "anyOf": [
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "clip-properties"
     },
     "edits": {
      "type": "array",
      "items": {
       "type": "object",
       "properties": {
        "clipId": {
         "type": "string",
         "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
        },
        "patch": {
         "type": "object",
         "properties": {
          "transform": {},
          "transition": {},
          "gain": {
           "type": "number",
           "minimum": 0,
           "maximum": 2
          },
          "fadeInFrames": {
           "type": "integer",
           "minimum": 0,
           "maximum": 300000
          },
          "fadeOutFrames": {
           "type": "integer",
           "minimum": 0,
           "maximum": 300000
          },
          "colour": {},
          "audioRole": {},
          "volumeEnvelope": {},
          "name": {
           "type": "string",
           "minLength": 1,
           "maxLength": 200
          },
          "muted": {
           "type": "boolean"
          }
         },
         "additionalProperties": false
        }
       },
       "required": [
        "clipId",
        "patch"
       ],
       "additionalProperties": false
      },
      "minItems": 1,
      "maxItems": 100
     }
    },
    "required": [
     "kind",
     "edits"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "replace-source"
     },
     "clipId": {
      "type": "string",
      "format": "uuid"
     },
     "assetId": {
      "type": "string",
      "format": "uuid"
     },
     "versionId": {
      "type": "string",
      "format": "uuid"
     }
    },
    "required": [
     "kind",
     "clipId",
     "assetId"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "copy-as-new-shot"
     },
     "clipId": {
      "type": "string",
      "format": "uuid"
     }
    },
    "required": [
     "kind",
     "clipId"
    ],
    "additionalProperties": false
   }
  ],
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object"
 },
 "sequence.action.commit": {
  "type": "object",
  "properties": {
   "envelope": {
    "type": "object",
    "properties": {
     "contractVersion": {
      "type": "number",
      "const": 1
     },
     "epoch": {
      "type": "string",
      "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
     },
     "actionId": {
      "type": "string",
      "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
     },
     "filmId": {
      "type": "string",
      "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
     },
     "originSide": {
      "type": "string",
      "enum": [
       "board",
       "timeline"
      ]
     },
     "origin": {
      "type": "string",
      "enum": [
       "user",
       "mio"
      ]
     },
     "intents": {
      "type": "array",
      "items": {
       "type": "object",
       "properties": {
        "side": {
         "type": "string",
         "enum": [
          "board",
          "timeline"
         ]
        },
        "operation": {
         "type": "object",
         "properties": {
          "kind": {
           "type": "string",
           "enum": [
            "board",
            "sync-board",
            "board-version",
            "track",
            "board.root.create",
            "board.shot.append",
            "board.layout.move",
            "board.node.create",
            "board.shot.update",
            "board.node.update",
            "board.restore",
            "board.paste",
            "board.duplicate"
           ]
          }
         },
         "required": [
          "kind"
         ],
         "additionalProperties": true
        }
       },
       "required": [
        "side",
        "operation"
       ],
       "additionalProperties": false
      },
      "maxItems": 2
     },
     "subjectIntent": {
      "type": "object",
      "properties": {
       "side": {
        "type": "string",
        "const": "board"
       },
       "operation": {
        "anyOf": [
         {
          "type": "object",
          "properties": {
           "kind": {
            "type": "string",
            "const": "subject-binding"
           },
           "edit": {
            "anyOf": [
             {
              "type": "object",
              "properties": {
               "kind": {
                "type": "string",
                "const": "create"
               },
               "bindingId": {
                "type": "string",
                "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
               },
               "shotId": {
                "type": "string",
                "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
               },
               "subjectId": {
                "type": "string",
                "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
               },
               "role": {
                "type": "string",
                "enum": [
                 "subject",
                 "style"
                ]
               }
              },
              "required": [
               "kind",
               "bindingId",
               "shotId",
               "subjectId",
               "role"
              ],
              "additionalProperties": false
             },
             {
              "type": "object",
              "properties": {
               "kind": {
                "type": "string",
                "const": "set-mode"
               },
               "bindingId": {
                "type": "string",
                "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
               },
               "bindingMode": {
                "type": "string",
                "enum": [
                 "follow",
                 "locked"
                ]
               },
               "subjectVersionId": {
                "anyOf": [
                 {
                  "type": "string",
                  "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
                 },
                 {
                  "type": "null"
                 }
                ]
               }
              },
              "required": [
               "kind",
               "bindingId",
               "bindingMode",
               "subjectVersionId"
              ],
              "additionalProperties": false
             },
             {
              "type": "object",
              "properties": {
               "kind": {
                "type": "string",
                "const": "detach"
               },
               "bindingId": {
                "type": "string",
                "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
               }
              },
              "required": [
               "kind",
               "bindingId"
              ],
              "additionalProperties": false
             },
             {
              "type": "object",
              "properties": {
               "kind": {
                "type": "string",
                "const": "restore"
               },
               "bindingId": {
                "type": "string",
                "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
               },
               "bindingMode": {
                "type": "string",
                "enum": [
                 "follow",
                 "locked"
                ]
               },
               "subjectVersionId": {
                "anyOf": [
                 {
                  "type": "string",
                  "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
                 },
                 {
                  "type": "null"
                 }
                ]
               }
              },
              "required": [
               "kind",
               "bindingId",
               "bindingMode",
               "subjectVersionId"
              ],
              "additionalProperties": false
             }
            ]
           }
          },
          "required": [
           "kind",
           "edit"
          ],
          "additionalProperties": false
         },
         {
          "anyOf": [
           {
            "type": "object",
            "properties": {
             "kind": {
              "type": "string",
              "const": "subject.card.create"
             },
             "nodeId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             },
             "subjectId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             },
             "position": {
              "type": "object",
              "properties": {
               "x": {
                "type": "number"
               },
               "y": {
                "type": "number"
               }
              },
              "required": [
               "x",
               "y"
              ],
              "additionalProperties": false
             }
            },
            "required": [
             "kind",
             "nodeId",
             "subjectId",
             "position"
            ],
            "additionalProperties": false
           },
           {
            "type": "object",
            "properties": {
             "kind": {
              "type": "string",
              "const": "subject.card.delete"
             },
             "nodeId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             }
            },
            "required": [
             "kind",
             "nodeId"
            ],
            "additionalProperties": false
           }
          ]
         }
        ]
       }
      },
      "required": [
       "side",
       "operation"
      ],
      "additionalProperties": false
     },
     "referenceIntent": {
      "type": "object",
      "properties": {
       "side": {
        "type": "string",
        "const": "board"
       },
       "operation": {
        "type": "object",
        "properties": {
         "kind": {
          "type": "string",
          "const": "reference-edge"
         },
         "edit": {
          "anyOf": [
           {
            "type": "object",
            "properties": {
             "kind": {
              "type": "string",
              "const": "attach"
             },
             "edgeId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             },
             "shotId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             },
             "sourceNodeId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             },
             "role": {
              "type": "string",
              "enum": [
               "first_frame",
               "last_frame",
               "reference_image",
               "subject_reference",
               "style_reference",
               "composition",
               "reference_audio",
               "reference_video"
              ]
             }
            },
            "required": [
             "kind",
             "edgeId",
             "shotId",
             "sourceNodeId"
            ],
            "additionalProperties": false
           },
           {
            "type": "object",
            "properties": {
             "kind": {
              "type": "string",
              "const": "set-role"
             },
             "edgeId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             },
             "shotId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             },
             "role": {
              "type": "string",
              "enum": [
               "first_frame",
               "last_frame",
               "reference_image",
               "subject_reference",
               "style_reference",
               "composition",
               "reference_audio",
               "reference_video"
              ]
             }
            },
            "required": [
             "kind",
             "edgeId",
             "shotId",
             "role"
            ],
            "additionalProperties": false
           },
           {
            "type": "object",
            "properties": {
             "kind": {
              "type": "string",
              "const": "detach"
             },
             "edgeId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             },
             "shotId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             }
            },
            "required": [
             "kind",
             "edgeId",
             "shotId"
            ],
            "additionalProperties": false
           },
           {
            "type": "object",
            "properties": {
             "kind": {
              "type": "string",
              "const": "reorder"
             },
             "shotId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             },
             "edgeIds": {
              "type": "array",
              "items": {
               "type": "string",
               "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
              },
              "minItems": 1,
              "maxItems": 48
             }
            },
            "required": [
             "kind",
             "shotId",
             "edgeIds"
            ],
            "additionalProperties": false
           }
          ]
         }
        },
        "required": [
         "kind",
         "edit"
        ],
        "additionalProperties": false
       }
      },
      "required": [
       "side",
       "operation"
      ],
      "additionalProperties": false
     },
     "propertiesIntent": {
      "type": "object",
      "properties": {
       "side": {
        "type": "string",
        "const": "timeline"
       },
       "operation": {
        "type": "object",
        "properties": {
         "kind": {
          "type": "string",
          "const": "clip-properties"
         },
         "edits": {
          "type": "array",
          "items": {
           "type": "object",
           "properties": {
            "clipId": {
             "type": "string",
             "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
            },
            "patch": {
             "type": "object",
             "properties": {
              "transform": {},
              "transition": {},
              "gain": {
               "type": "number",
               "minimum": 0,
               "maximum": 2
              },
              "fadeInFrames": {
               "type": "integer",
               "minimum": 0,
               "maximum": 300000
              },
              "fadeOutFrames": {
               "type": "integer",
               "minimum": 0,
               "maximum": 300000
              },
              "colour": {},
              "audioRole": {},
              "volumeEnvelope": {},
              "name": {
               "type": "string",
               "minLength": 1,
               "maxLength": 200
              },
              "muted": {
               "type": "boolean"
              },
              "sourceReplacement": {
               "type": "object",
               "properties": {
                "assetId": {
                 "type": "string",
                 "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
                },
                "versionId": {
                 "type": "string",
                 "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
                }
               },
               "required": [
                "assetId"
               ],
               "additionalProperties": false
              }
             },
             "additionalProperties": false
            }
           },
           "required": [
            "clipId",
            "patch"
           ],
           "additionalProperties": false
          },
          "minItems": 1,
          "maxItems": 100
         }
        },
        "required": [
         "kind",
         "edits"
        ],
        "additionalProperties": false
       }
      },
      "required": [
       "side",
       "operation"
      ],
      "additionalProperties": false
     },
     "previsIntent": {
      "type": "object",
      "properties": {
       "side": {
        "type": "string",
        "const": "board"
       },
       "operation": {
        "anyOf": [
         {
          "type": "object",
          "properties": {
           "kind": {
            "type": "string",
            "const": "previs-create"
           },
           "nodeId": {
            "type": "string",
            "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
           },
           "label": {
            "type": "string",
            "maxLength": 150
           },
           "position": {
            "type": "object",
            "properties": {
             "x": {
              "type": "number"
             },
             "y": {
              "type": "number"
             }
            },
            "required": [
             "x",
             "y"
            ],
            "additionalProperties": false
           }
          },
          "required": [
           "kind",
           "nodeId",
           "label",
           "position"
          ],
          "additionalProperties": false
         },
         {
          "type": "object",
          "properties": {
           "kind": {
            "type": "string",
            "const": "previs-scene-set"
           },
           "nodeId": {
            "type": "string",
            "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
           },
           "expectedSceneRevision": {
            "type": "integer",
            "minimum": 1,
            "maximum": 9007199254740991
           },
           "scene": {
            "type": "object",
            "properties": {
             "schemaVersion": {
              "type": "number",
              "const": 1
             },
             "figures": {
              "type": "array",
              "items": {
               "type": "object",
               "properties": {
                "id": {
                 "type": "string",
                 "pattern": "^f[1-9][0-9]{0,3}$"
                },
                "name": {
                 "type": "string",
                 "maxLength": 20,
                 "pattern": "^[^\\u0000-\\u001f\\u007f-\\u009f\\ud800-\\udfff]*$"
                },
                "visible": {
                 "type": "boolean"
                },
                "position": {
                 "type": "array",
                 "minItems": 3,
                 "maxItems": 3,
                 "items": [
                  {
                   "type": "number",
                   "minimum": -100,
                   "maximum": 100
                  },
                  {
                   "type": "number",
                   "minimum": -100,
                   "maximum": 100
                  },
                  {
                   "type": "number",
                   "minimum": -100,
                   "maximum": 100
                  }
                 ]
                },
                "rotation": {
                 "type": "number",
                 "minimum": -180,
                 "maximum": 180
                },
                "pose": {
                 "type": "string",
                 "enum": [
                  "stand",
                  "walk",
                  "sit",
                  "hold",
                  "look-back"
                 ]
                },
                "held": {
                 "anyOf": [
                  {
                   "type": "object",
                   "properties": {
                    "propId": {
                     "type": "string",
                     "pattern": "^p[1-9][0-9]{0,3}$"
                    },
                    "hand": {
                     "type": "string",
                     "enum": [
                      "left",
                      "right"
                     ]
                    }
                   },
                   "required": [
                    "propId",
                    "hand"
                   ],
                   "additionalProperties": false
                  },
                  {
                   "type": "null"
                  }
                 ]
                },
                "subject": {
                 "type": "object",
                 "properties": {
                  "subjectId": {
                   "type": "string",
                   "format": "uuid"
                  },
                  "subjectVersionId": {
                   "type": "string",
                   "format": "uuid"
                  }
                 },
                 "required": [
                  "subjectId"
                 ],
                 "additionalProperties": false
                }
               },
               "required": [
                "id",
                "name",
                "visible",
                "position",
                "rotation",
                "pose",
                "held"
               ],
               "additionalProperties": false
              },
              "maxItems": 8
             },
             "props": {
              "type": "array",
              "items": {
               "type": "object",
               "properties": {
                "id": {
                 "type": "string",
                 "pattern": "^p[1-9][0-9]{0,3}$"
                },
                "kind": {
                 "type": "string",
                 "enum": [
                  "box",
                  "cylinder",
                  "sphere",
                  "panel",
                  "umbrella",
                  "phone",
                  "bag",
                  "cup"
                 ]
                },
                "name": {
                 "type": "string",
                 "maxLength": 20,
                 "pattern": "^[^\\u0000-\\u001f\\u007f-\\u009f\\ud800-\\udfff]*$"
                },
                "visible": {
                 "type": "boolean"
                },
                "position": {
                 "type": "array",
                 "minItems": 3,
                 "maxItems": 3,
                 "items": [
                  {
                   "type": "number",
                   "minimum": -100,
                   "maximum": 100
                  },
                  {
                   "type": "number",
                   "minimum": -100,
                   "maximum": 100
                  },
                  {
                   "type": "number",
                   "minimum": -100,
                   "maximum": 100
                  }
                 ]
                },
                "rotation": {
                 "type": "number",
                 "minimum": -180,
                 "maximum": 180
                },
                "size": {
                 "type": "array",
                 "minItems": 3,
                 "maxItems": 3,
                 "items": [
                  {
                   "type": "number",
                   "minimum": 0.01,
                   "maximum": 20
                  },
                  {
                   "type": "number",
                   "minimum": 0.01,
                   "maximum": 20
                  },
                  {
                   "type": "number",
                   "minimum": 0.01,
                   "maximum": 20
                  }
                 ]
                },
                "subject": {
                 "type": "object",
                 "properties": {
                  "subjectId": {
                   "type": "string",
                   "format": "uuid"
                  },
                  "subjectVersionId": {
                   "type": "string",
                   "format": "uuid"
                  }
                 },
                 "required": [
                  "subjectId"
                 ],
                 "additionalProperties": false
                }
               },
               "required": [
                "id",
                "kind",
                "name",
                "visible",
                "position",
                "rotation",
                "size"
               ],
               "additionalProperties": false
              },
              "maxItems": 24
             },
             "light": {
              "type": "object",
              "properties": {
               "visible": {
                "type": "boolean"
               },
               "azimuth": {
                "type": "number",
                "minimum": -180,
                "maximum": 180
               },
               "elevation": {
                "type": "number",
                "minimum": -90,
                "maximum": 90
               },
               "intensity": {
                "type": "number",
                "minimum": 0,
                "maximum": 4
               }
              },
              "required": [
               "visible",
               "azimuth",
               "elevation",
               "intensity"
              ],
              "additionalProperties": false
             },
             "camera": {
              "type": "object",
              "properties": {
               "position": {
                "type": "array",
                "minItems": 3,
                "maxItems": 3,
                "items": [
                 {
                  "type": "number",
                  "minimum": -100,
                  "maximum": 100
                 },
                 {
                  "type": "number",
                  "minimum": -100,
                  "maximum": 100
                 },
                 {
                  "type": "number",
                  "minimum": -100,
                  "maximum": 100
                 }
                ]
               },
               "yaw": {
                "type": "number",
                "minimum": -180,
                "maximum": 180
               },
               "pitch": {
                "type": "number",
                "minimum": -90,
                "maximum": 90
               },
               "focalLength": {
                "type": "number",
                "minimum": 10,
                "maximum": 300
               }
              },
              "required": [
               "position",
               "yaw",
               "pitch",
               "focalLength"
              ],
              "additionalProperties": false
             },
             "keyframes": {
              "type": "array",
              "items": {
               "type": "object",
               "properties": {
                "id": {
                 "type": "string",
                 "pattern": "^k[1-9][0-9]{0,3}$"
                },
                "name": {
                 "type": "string",
                 "maxLength": 20,
                 "pattern": "^[^\\u0000-\\u001f\\u007f-\\u009f\\ud800-\\udfff]*$"
                },
                "camera": {
                 "type": "object",
                 "properties": {
                  "position": {
                   "type": "array",
                   "minItems": 3,
                   "maxItems": 3,
                   "items": [
                    {
                     "type": "number",
                     "minimum": -100,
                     "maximum": 100
                    },
                    {
                     "type": "number",
                     "minimum": -100,
                     "maximum": 100
                    },
                    {
                     "type": "number",
                     "minimum": -100,
                     "maximum": 100
                    }
                   ]
                  },
                  "yaw": {
                   "type": "number",
                   "minimum": -180,
                   "maximum": 180
                  },
                  "pitch": {
                   "type": "number",
                   "minimum": -90,
                   "maximum": 90
                  },
                  "focalLength": {
                   "type": "number",
                   "minimum": 10,
                   "maximum": 300
                  }
                 },
                 "required": [
                  "position",
                  "yaw",
                  "pitch",
                  "focalLength"
                 ],
                 "additionalProperties": false
                },
                "exports": {
                 "type": "array",
                 "items": {
                  "type": "string",
                  "format": "uuid"
                 },
                 "maxItems": 4
                }
               },
               "required": [
                "id",
                "name",
                "camera",
                "exports"
               ],
               "additionalProperties": false
              },
              "maxItems": 24
             },
             "activeKeyframeId": {
              "anyOf": [
               {
                "type": "string",
                "pattern": "^k[1-9][0-9]{0,3}$"
               },
               {
                "type": "null"
               }
              ]
             }
            },
            "required": [
             "schemaVersion",
             "figures",
             "props",
             "light",
             "camera",
             "keyframes",
             "activeKeyframeId"
            ],
            "additionalProperties": false
           }
          },
          "required": [
           "kind",
           "nodeId",
           "expectedSceneRevision",
           "scene"
          ],
          "additionalProperties": false
         }
        ]
       }
      },
      "required": [
       "side",
       "operation"
      ],
      "additionalProperties": false
     },
     "subtitlesIntent": {
      "type": "object",
      "properties": {
       "side": {
        "type": "string",
        "const": "timeline"
       },
       "operation": {
        "type": "object",
        "properties": {
         "kind": {
          "type": "string",
          "const": "subtitles"
         },
         "edits": {
          "type": "array",
          "items": {
           "anyOf": [
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "add"
              },
              "cue": {
               "type": "object",
               "properties": {
                "id": {
                 "type": "string",
                 "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
                },
                "text": {
                 "type": "string",
                 "maxLength": 256
                },
                "startFrame": {
                 "type": "integer",
                 "minimum": 0,
                 "maximum": 300000
                },
                "durationFrames": {
                 "type": "integer",
                 "minimum": 1,
                 "maximum": 300000
                },
                "anchor": {
                 "anyOf": [
                  {
                   "type": "object",
                   "properties": {
                    "clipId": {
                     "type": "string",
                     "format": "uuid"
                    },
                    "offsetFrames": {
                     "type": "integer",
                     "minimum": 0,
                     "maximum": 300000
                    }
                   },
                   "required": [
                    "clipId",
                    "offsetFrames"
                   ],
                   "additionalProperties": false
                  },
                  {
                   "type": "null"
                  }
                 ]
                },
                "dialogueRef": {
                 "anyOf": [
                  {
                   "type": "object",
                   "properties": {
                    "shotId": {
                     "type": "string",
                     "format": "uuid"
                    },
                    "lineId": {
                     "type": "string",
                     "format": "uuid"
                    }
                   },
                   "required": [
                    "shotId",
                    "lineId"
                   ],
                   "additionalProperties": false
                  },
                  {
                   "type": "null"
                  }
                 ]
                }
               },
               "required": [
                "id",
                "text",
                "startFrame",
                "durationFrames"
               ],
               "additionalProperties": false
              }
             },
             "required": [
              "kind",
              "cue"
             ],
             "additionalProperties": false
            },
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "update"
              },
              "cueId": {
               "type": "string",
               "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
              },
              "patch": {
               "type": "object",
               "properties": {
                "text": {
                 "type": "string",
                 "maxLength": 256
                },
                "startFrame": {
                 "type": "integer",
                 "minimum": 0,
                 "maximum": 300000
                },
                "durationFrames": {
                 "type": "integer",
                 "minimum": 1,
                 "maximum": 300000
                },
                "anchor": {
                 "anyOf": [
                  {
                   "type": "object",
                   "properties": {
                    "clipId": {
                     "type": "string",
                     "format": "uuid"
                    },
                    "offsetFrames": {
                     "type": "integer",
                     "minimum": 0,
                     "maximum": 300000
                    }
                   },
                   "required": [
                    "clipId",
                    "offsetFrames"
                   ],
                   "additionalProperties": false
                  },
                  {
                   "type": "null"
                  }
                 ]
                },
                "dialogueRef": {
                 "anyOf": [
                  {
                   "type": "object",
                   "properties": {
                    "shotId": {
                     "type": "string",
                     "format": "uuid"
                    },
                    "lineId": {
                     "type": "string",
                     "format": "uuid"
                    }
                   },
                   "required": [
                    "shotId",
                    "lineId"
                   ],
                   "additionalProperties": false
                  },
                  {
                   "type": "null"
                  }
                 ]
                }
               },
               "additionalProperties": false
              }
             },
             "required": [
              "kind",
              "cueId",
              "patch"
             ],
             "additionalProperties": false
            },
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "remove"
              },
              "cueId": {
               "type": "string",
               "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
              }
             },
             "required": [
              "kind",
              "cueId"
             ],
             "additionalProperties": false
            }
           ]
          },
          "minItems": 1,
          "maxItems": 100
         }
        },
        "required": [
         "kind",
         "edits"
        ],
        "additionalProperties": false
       }
      },
      "required": [
       "side",
       "operation"
      ],
      "additionalProperties": false
     },
     "dialogueIntent": {
      "type": "object",
      "properties": {
       "side": {
        "type": "string",
        "enum": [
         "board",
         "timeline"
        ]
       },
       "operation": {
        "type": "object",
        "properties": {
         "kind": {
          "type": "string",
          "const": "dialogue"
         },
         "edits": {
          "type": "array",
          "items": {
           "anyOf": [
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "add"
              },
              "shotId": {
               "type": "string",
               "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
              },
              "line": {
               "type": "object",
               "properties": {
                "id": {
                 "type": "string",
                 "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
                },
                "text": {
                 "type": "string"
                },
                "speakerSubjectId": {
                 "type": "string",
                 "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
                }
               },
               "required": [
                "id",
                "text"
               ],
               "additionalProperties": false
              },
              "beforeLineId": {
               "anyOf": [
                {
                 "type": "string",
                 "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
                },
                {
                 "type": "null"
                }
               ]
              }
             },
             "required": [
              "kind",
              "shotId",
              "line"
             ],
             "additionalProperties": false
            },
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "update"
              },
              "shotId": {
               "type": "string",
               "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
              },
              "lineId": {
               "type": "string",
               "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
              },
              "text": {
               "type": "string"
              },
              "speakerSubjectId": {
               "anyOf": [
                {
                 "type": "string",
                 "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
                },
                {
                 "type": "null"
                }
               ]
              }
             },
             "required": [
              "kind",
              "shotId",
              "lineId"
             ],
             "additionalProperties": false
            },
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "remove"
              },
              "shotId": {
               "type": "string",
               "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
              },
              "lineId": {
               "type": "string",
               "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
              }
             },
             "required": [
              "kind",
              "shotId",
              "lineId"
             ],
             "additionalProperties": false
            },
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "reorder"
              },
              "shotId": {
               "type": "string",
               "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
              },
              "lineIds": {
               "type": "array",
               "items": {
                "type": "string",
                "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
               },
               "maxItems": 1000
              }
             },
             "required": [
              "kind",
              "shotId",
              "lineIds"
             ],
             "additionalProperties": false
            },
            {
             "type": "object",
             "properties": {
              "kind": {
               "type": "string",
               "const": "set-text-by-cue"
              },
              "cueId": {
               "type": "string",
               "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
              },
              "text": {
               "type": "string"
              }
             },
             "required": [
              "kind",
              "cueId",
              "text"
             ],
             "additionalProperties": false
            }
           ]
          },
          "minItems": 1,
          "maxItems": 100
         }
        },
        "required": [
         "kind",
         "edits"
        ],
        "additionalProperties": false
       }
      },
      "required": [
       "side",
       "operation"
      ],
      "additionalProperties": false
     },
     "trackIntent": {
      "type": "object",
      "properties": {
       "side": {
        "type": "string",
        "const": "timeline"
       },
       "operation": {
        "type": "object",
        "properties": {
         "kind": {
          "type": "string",
          "const": "track-structure"
         },
         "edit": {
          "anyOf": [
           {
            "type": "object",
            "properties": {
             "kind": {
              "type": "string",
              "const": "add"
             },
             "trackId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             },
             "trackKind": {
              "type": "string",
              "enum": [
               "video",
               "audio"
              ]
             },
             "name": {
              "type": "string",
              "minLength": 1,
              "maxLength": 150
             },
             "orderIndex": {
              "type": "integer",
              "minimum": 0,
              "maximum": 11
             }
            },
            "required": [
             "kind",
             "trackId",
             "trackKind"
            ],
            "additionalProperties": false
           },
           {
            "type": "object",
            "properties": {
             "kind": {
              "type": "string",
              "const": "update"
             },
             "trackId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             },
             "patch": {
              "type": "object",
              "properties": {
               "name": {
                "type": "string",
                "minLength": 1,
                "maxLength": 150
               },
               "hidden": {
                "type": "boolean"
               },
               "muted": {
                "type": "boolean"
               },
               "orderIndex": {
                "type": "integer",
                "minimum": 0,
                "maximum": 11
               }
              },
              "additionalProperties": false
             }
            },
            "required": [
             "kind",
             "trackId",
             "patch"
            ],
            "additionalProperties": false
           }
          ]
         }
        },
        "required": [
         "kind",
         "edit"
        ],
        "additionalProperties": false
       }
      },
      "required": [
       "side",
       "operation"
      ],
      "additionalProperties": false
     },
     "soundIntent": {
      "type": "object",
      "properties": {
       "side": {
        "type": "string",
        "const": "timeline"
       },
       "operation": {
        "type": "object",
        "properties": {
         "kind": {
          "type": "string",
          "const": "separate-sound"
         },
         "clipId": {
          "type": "string",
          "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
         },
         "audioClipId": {
          "type": "string",
          "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
         },
         "audioTrackId": {
          "type": "string",
          "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
         },
         "createdTrackId": {
          "type": "string",
          "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
         },
         "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
         },
         "trackName": {
          "type": "string",
          "minLength": 1,
          "maxLength": 150
         }
        },
        "required": [
         "kind",
         "clipId"
        ],
        "additionalProperties": false
       }
      },
      "required": [
       "side",
       "operation"
      ],
      "additionalProperties": false
     },
     "formatIntent": {
      "type": "object",
      "properties": {
       "side": {
        "type": "string",
        "const": "timeline"
       },
       "operation": {
        "type": "object",
        "properties": {
         "kind": {
          "type": "string",
          "const": "timeline-format"
         },
         "presetId": {
          "type": "string",
          "enum": [
           "portrait_1080",
           "landscape_1080",
           "square_1080",
           "portrait_720",
           "landscape_720",
           "square_720"
          ]
         }
        },
        "required": [
         "kind",
         "presetId"
        ],
        "additionalProperties": false
       }
      },
      "required": [
       "side",
       "operation"
      ],
      "additionalProperties": false
     },
     "generateIntent": {
      "type": "object",
      "properties": {
       "side": {
        "type": "string",
        "const": "timeline"
       },
       "operation": {
        "anyOf": [
         {
          "type": "object",
          "properties": {
           "kind": {
            "type": "string",
            "const": "generate-placeholder"
           },
           "placement": {
            "anyOf": [
             {
              "type": "object",
              "properties": {
               "kind": {
                "type": "string",
                "const": "main"
               },
               "beforeClipId": {
                "anyOf": [
                 {
                  "type": "string",
                  "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
                 },
                 {
                  "type": "null"
                 }
                ]
               }
              },
              "required": [
               "kind",
               "beforeClipId"
              ],
              "additionalProperties": false
             },
             {
              "type": "object",
              "properties": {
               "kind": {
                "type": "string",
                "const": "track"
               },
               "trackId": {
                "type": "string",
                "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
               },
               "startFrame": {
                "type": "integer",
                "minimum": 0,
                "maximum": 300000
               }
              },
              "required": [
               "kind",
               "trackId",
               "startFrame"
              ],
              "additionalProperties": false
             }
            ]
           },
           "settings": {
            "type": "object",
            "properties": {
             "providerId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 120
             },
             "model": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
             },
             "region": {
              "type": "string",
              "minLength": 1,
              "maxLength": 120
             },
             "prompt": {
              "type": "string",
              "maxLength": 5000
             },
             "aspectRatio": {
              "type": "string",
              "minLength": 1,
              "maxLength": 40
             },
             "duration": {
              "type": "integer",
              "minimum": 1,
              "maximum": 60
             },
             "parameters": {
              "type": "object",
              "additionalProperties": {}
             },
             "connectionId": {
              "type": "string",
              "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
             },
             "configurationRevision": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
             },
             "modelEntryId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
             }
            },
            "required": [
             "prompt",
             "aspectRatio",
             "duration"
            ],
            "additionalProperties": false
           },
           "shotId": {
            "type": "string",
            "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
           },
           "clipId": {
            "type": "string",
            "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
           },
           "title": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
           },
           "submit": {
            "type": "boolean"
           },
           "position": {
            "type": "object",
            "properties": {
             "x": {
              "type": "number"
             },
             "y": {
              "type": "number"
             }
            },
            "required": [
             "x",
             "y"
            ],
            "additionalProperties": false
           }
          },
          "required": [
           "kind",
           "placement",
           "settings",
           "shotId",
           "clipId",
           "title"
          ],
          "additionalProperties": false
         },
         {
          "type": "object",
          "properties": {
           "kind": {
            "type": "string",
            "const": "generate-resize"
           },
           "shotId": {
            "type": "string",
            "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
           },
           "duration": {
            "type": "integer",
            "minimum": 1,
            "maximum": 60
           }
          },
          "required": [
           "kind",
           "shotId",
           "duration"
          ],
          "additionalProperties": false
         }
        ]
       }
      },
      "required": [
       "side",
       "operation"
      ],
      "additionalProperties": false
     },
     "baseline": {
      "type": "object",
      "properties": {
       "contentRevision": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
       },
       "timelineRevision": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
       },
       "syncRevision": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
       },
       "historyPosition": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
       },
       "historyRevision": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
       },
       "targets": {
        "type": "array",
        "items": {
         "type": "object",
         "properties": {
          "kind": {
           "type": "string",
           "enum": [
            "shot",
            "node",
            "edge",
            "clip",
            "cue",
            "subject_binding",
            "timeline_track"
           ]
          },
          "id": {
           "type": "string",
           "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
          },
          "revision": {
           "type": "integer",
           "minimum": 1,
           "maximum": 9007199254740991
          }
         },
         "required": [
          "kind",
          "id",
          "revision"
         ],
         "additionalProperties": false
        },
        "maxItems": 2500
       }
      },
      "required": [
       "contentRevision",
       "timelineRevision",
       "syncRevision",
       "historyPosition",
       "historyRevision",
       "targets"
      ],
      "additionalProperties": false
     },
     "impact": {
      "type": "object",
      "properties": {
       "nodeIds": {
        "type": "array",
        "items": {
         "type": "string",
         "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
        },
        "maxItems": 2500
       },
       "edgeIds": {
        "type": "array",
        "items": {
         "type": "string",
         "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
        },
        "maxItems": 2500
       },
       "mainTrackClipIds": {
        "type": "array",
        "items": {
         "type": "string",
         "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
        },
        "maxItems": 2500
       },
       "otherTrackItemIds": {
        "type": "array",
        "items": {
         "type": "string",
         "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
        },
        "maxItems": 2500
       },
       "subtitleCueIds": {
        "type": "array",
        "items": {
         "type": "string",
         "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
        },
        "maxItems": 2500
       },
       "subjectBindingIds": {
        "type": "array",
        "items": {
         "type": "string",
         "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
        },
        "maxItems": 2500
       },
       "trackIds": {
        "type": "array",
        "items": {
         "type": "string",
         "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
        },
        "maxItems": 2500
       }
      },
      "required": [
       "nodeIds",
       "edgeIds",
       "mainTrackClipIds",
       "otherTrackItemIds",
       "subtitleCueIds"
      ],
      "additionalProperties": false
     },
     "allocation": {
      "type": "object",
      "properties": {
       "clips": {
        "type": "array",
        "items": {
         "type": "object",
         "properties": {
          "nodeId": {
           "type": "string",
           "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
          },
          "clipId": {
           "type": "string",
           "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
          }
         },
         "required": [
          "nodeId",
          "clipId"
         ],
         "additionalProperties": false
        },
        "maxItems": 2500
       },
       "nodes": {
        "type": "array",
        "items": {
         "type": "object",
         "properties": {
          "fromNodeId": {
           "type": "string",
           "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
          },
          "nodeId": {
           "type": "string",
           "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
          }
         },
         "required": [
          "fromNodeId",
          "nodeId"
         ],
         "additionalProperties": false
        },
        "maxItems": 2500
       },
       "splitClips": {
        "type": "array",
        "items": {
         "type": "object",
         "properties": {
          "clipId": {
           "type": "string",
           "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
          },
          "rightClipId": {
           "type": "string",
           "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
          }
         },
         "required": [
          "clipId",
          "rightClipId"
         ],
         "additionalProperties": false
        },
        "maxItems": 2500
       },
       "edges": {
        "type": "array",
        "items": {
         "type": "object",
         "properties": {
          "id": {
           "type": "string",
           "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
          },
          "fromId": {
           "type": "string",
           "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
          },
          "toId": {
           "type": "string",
           "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
          }
         },
         "required": [
          "id",
          "fromId",
          "toId"
         ],
         "additionalProperties": false
        },
        "maxItems": 2500
       }
      },
      "required": [
       "clips",
       "nodes",
       "splitClips",
       "edges"
      ],
      "additionalProperties": false
     }
    },
    "required": [
     "contractVersion",
     "epoch",
     "actionId",
     "filmId",
     "originSide",
     "intents",
     "baseline",
     "impact",
     "allocation"
    ],
    "additionalProperties": false
   },
   "expectedPlanDigest": {
    "type": "string",
    "pattern": "^[a-f0-9]{64}$"
   }
  },
  "required": [
   "envelope",
   "expectedPlanDigest"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "sequence.inspect": {
  "type": "object",
  "properties": {
   "rootId": {
    "type": "string",
    "format": "uuid"
   },
   "limit": {
    "type": "integer",
    "minimum": 1,
    "maximum": 50
   },
   "cursor": {
    "type": "string",
    "minLength": 1,
    "maxLength": 512,
    "pattern": "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{43}$"
   }
  },
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "sequence.generation-inputs.get": {
  "type": "object",
  "properties": {
   "shotId": {
    "type": "string",
    "format": "uuid"
   },
   "connectionId": {
    "type": "string",
    "format": "uuid"
   },
   "configurationRevision": {
    "type": "integer",
    "exclusiveMinimum": 0
   },
   "modelEntryId": {
    "type": "string",
    "format": "uuid"
   },
   "generateAudio": {
    "type": "boolean"
   }
  },
  "required": [
   "shotId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "export.cancel": {
  "type": "object",
  "properties": {
   "exportId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "exportId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "export.activity.get": {
  "type": "object",
  "properties": {
   "exportId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "exportId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "export.output.get": {
  "type": "object",
  "properties": {
   "exportId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "exportId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "clip.audio.export": {
  "type": "object",
  "properties": {
   "clipId": {
    "type": "string",
    "format": "uuid"
   },
   "outputLocale": {
    "type": "string",
    "enum": [
     "zh-Hans",
     "zh-Hant",
     "en",
     "ja"
    ]
   }
  },
  "required": [
   "clipId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "clip.audio.export.get": {
  "type": "object",
  "properties": {
   "exportId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "exportId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "workspace.settings.get": {
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "workspace.settings.set": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "minimum": 0,
    "maximum": 9007199254740991
   },
   "liveGeneration": {
    "type": "boolean"
   }
  },
  "required": [
   "expectedRevision",
   "liveGeneration"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "task.disposition.list": {
  "type": "object",
  "properties": {
   "targets": {
    "type": "array",
    "items": {
     "type": "object",
     "properties": {
      "kind": {
       "type": "string",
       "enum": [
        "generation",
        "render",
        "edit"
       ]
      },
      "taskId": {
       "type": "string",
       "format": "uuid"
      }
     },
     "required": [
      "kind",
      "taskId"
     ],
     "additionalProperties": false
    },
    "minItems": 1,
    "maxItems": 100
   }
  },
  "required": [
   "targets"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "task.disposition.markFailed": {
  "type": "object",
  "properties": {
   "kind": {
    "type": "string",
    "enum": [
     "generation",
     "render",
     "edit"
    ]
   },
   "taskId": {
    "type": "string",
    "format": "uuid"
   },
   "expectedRevision": {
    "type": "integer",
    "minimum": 0,
    "maximum": 9007199254740991
   },
   "expectedStatus": {
    "type": "string",
    "minLength": 1,
    "maxLength": 40
   },
   "confirm": {
    "type": "boolean",
    "const": true
   }
  },
  "required": [
   "kind",
   "taskId",
   "expectedRevision",
   "expectedStatus",
   "confirm"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "task.disposition.archiveCompleted": {
  "type": "object",
  "properties": {
   "targets": {
    "type": "array",
    "items": {
     "type": "object",
     "properties": {
      "kind": {
       "type": "string",
       "enum": [
        "generation",
        "render",
        "edit"
       ]
      },
      "taskId": {
       "type": "string",
       "format": "uuid"
      },
      "expectedRevision": {
       "type": "integer",
       "minimum": 0,
       "maximum": 9007199254740991
      },
      "expectedStatus": {
       "type": "string",
       "minLength": 1,
       "maxLength": 40
      }
     },
     "required": [
      "kind",
      "taskId",
      "expectedRevision",
      "expectedStatus"
     ],
     "additionalProperties": false
    },
    "minItems": 1,
    "maxItems": 100
   }
  },
  "required": [
   "targets"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "project.rename": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "exclusiveMinimum": 0,
    "maximum": 9007199254740991
   },
   "name": {
    "type": "string",
    "minLength": 1,
    "maxLength": 150
   }
  },
  "required": [
   "expectedRevision",
   "name"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "project.notes.set": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "exclusiveMinimum": 0,
    "maximum": 9007199254740991
   },
   "notes": {
    "type": "string",
    "maxLength": 8192
   }
  },
  "required": [
   "expectedRevision",
   "notes"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "project.delete": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "exclusiveMinimum": 0,
    "maximum": 9007199254740991
   },
   "projectFile": {
    "type": "string",
    "minLength": 1,
    "maxLength": 4096
   },
   "fileIdentity": {
    "type": "object",
    "properties": {
     "dev": {
      "type": "string",
      "pattern": "^(?:0|[1-9][0-9]{0,39})$"
     },
     "ino": {
      "type": "string",
      "pattern": "^(?:0|[1-9][0-9]{0,39})$"
     }
    },
    "required": [
     "dev",
     "ino"
    ],
    "additionalProperties": false
   },
   "confirmTrash": {
    "type": "boolean",
    "const": true
   }
  },
  "required": [
   "expectedRevision",
   "projectFile",
   "fileIdentity",
   "confirmTrash"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "project.summary.list": {
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "agent.authorization.list": {
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "agent.authorization.grant": {
  "type": "object",
  "properties": {
   "destination": {
    "type": "string",
    "minLength": 1,
    "maxLength": 2080
   },
   "model": {
    "type": "string",
    "minLength": 1,
    "maxLength": 200
   },
   "scope": {
    "type": "string",
    "enum": [
     "project_agent",
     "typed_chat_only",
     "project_inspection",
     "selected_shot_edit",
     "selected_timeline_clip_move",
     "selected_timeline_clip_gain"
    ]
   },
   "expectedRevision": {
    "type": "integer",
    "minimum": 0,
    "maximum": 9007199254740991
   },
   "expectedSettingsRevision": {
    "type": "integer",
    "minimum": 0,
    "maximum": 9007199254740991
   }
  },
  "required": [
   "destination",
   "model",
   "scope",
   "expectedRevision",
   "expectedSettingsRevision"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "agent.authorization.revoke": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "minimum": 0,
    "maximum": 9007199254740991
   },
   "authorizationId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "expectedRevision",
   "authorizationId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "lut.import": {
  "type": "object",
  "properties": {
   "name": {
    "type": "string",
    "minLength": 1,
    "maxLength": 200
   },
   "dataBase64": {
    "type": "string",
    "minLength": 4,
    "maxLength": 9786712
   }
  },
  "required": [
   "name",
   "dataBase64"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "lut.list": {
  "type": "object",
  "properties": {
   "limit": {
    "type": "integer",
    "minimum": 1,
    "maximum": 50,
    "default": 25
   },
   "after": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "lut.inspect": {
  "type": "object",
  "properties": {
   "lutId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "lutId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "lut.look.inspect": {
  "type": "object",
  "properties": {
   "lutId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "lutId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.colour.source.inspect": {
  "type": "object",
  "properties": {
   "assetId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "assetId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.colour.image.inspect": {
  "type": "object",
  "properties": {
   "assetId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "assetId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.colour.jpeg.inspect": {
  "type": "object",
  "properties": {
   "assetId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "assetId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.format.get": {
  "type": "object",
  "properties": {},
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.format.set": {
  "type": "object",
  "properties": {
   "expectedProjectRevision": {
    "type": "integer",
    "minimum": 1,
    "maximum": 9007199254740991
   },
   "expectedRevision": {
    "type": "integer",
    "minimum": 0,
    "maximum": 9007199254740990
   },
   "presetId": {
    "type": "string",
    "enum": [
     "portrait_1080",
     "landscape_1080",
     "square_1080",
     "portrait_720",
     "landscape_720",
     "square_720"
    ]
   }
  },
  "required": [
   "expectedProjectRevision",
   "expectedRevision",
   "presetId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.subtitle.add": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "minimum": 1,
    "maximum": 9007199254740991
   },
   "text": {
    "type": "string"
   },
   "startFrame": {
    "type": "integer",
    "minimum": 0,
    "maximum": 18000
   },
   "durationFrames": {
    "type": "integer",
    "minimum": 1,
    "maximum": 18000
   }
  },
  "required": [
   "expectedRevision",
   "text",
   "startFrame",
   "durationFrames"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.subtitle.update": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "minimum": 1,
    "maximum": 9007199254740991
   },
   "cueId": {
    "type": "string",
    "format": "uuid"
   },
   "patch": {
    "type": "object",
    "properties": {
     "text": {
      "type": "string"
     },
     "startFrame": {
      "type": "integer",
      "minimum": 0,
      "maximum": 18000
     },
     "durationFrames": {
      "type": "integer",
      "minimum": 1,
      "maximum": 18000
     }
    },
    "additionalProperties": false
   }
  },
  "required": [
   "expectedRevision",
   "cueId",
   "patch"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.subtitle.remove": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "minimum": 1,
    "maximum": 9007199254740991
   },
   "cueId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "expectedRevision",
   "cueId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "frame.extract": {
  "type": "object",
  "properties": {
   "sourceAssetId": {
    "type": "string",
    "format": "uuid"
   },
   "sourceHash": {
    "type": "string",
    "pattern": "^[a-f0-9]{64}$"
   },
   "sourceFrame": {
    "type": "integer",
    "minimum": 0,
    "maximum": 9007199254740991
   }
  },
  "required": [
   "sourceAssetId",
   "sourceHash",
   "sourceFrame"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "frame.request.get": {
  "type": "object",
  "properties": {},
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "frame.task.get": {
  "type": "object",
  "properties": {
   "taskId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "taskId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "frame.task.list": {
  "type": "object",
  "properties": {
   "limit": {
    "type": "integer",
    "minimum": 1,
    "maximum": 50
   },
   "cursor": {
    "type": "string",
    "minLength": 1,
    "maxLength": 768
   }
  },
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "frame.task.cancelQueued": {
  "type": "object",
  "properties": {
   "taskId": {
    "type": "string",
    "format": "uuid"
   },
   "expectedRevision": {
    "type": "integer",
    "minimum": 1,
    "maximum": 9007199254740991
   }
  },
  "required": [
   "taskId",
   "expectedRevision"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "frame.task.recoverResult": {
  "type": "object",
  "properties": {
   "taskId": {
    "type": "string",
    "format": "uuid"
   },
   "expectedRevision": {
    "type": "integer",
    "minimum": 1,
    "maximum": 9007199254740991
   }
  },
  "required": [
   "taskId",
   "expectedRevision"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "scene.detect": {
  "type": "object",
  "properties": {
   "sourceAssetId": {
    "type": "string",
    "format": "uuid"
   },
   "sourceHash": {
    "type": "string",
    "pattern": "^[a-f0-9]{64}$"
   },
   "options": {
    "type": "object",
    "properties": {
     "mode": {
      "type": "string",
      "enum": [
       "adaptive",
       "fixed"
      ]
     },
     "sensitivity": {
      "type": "integer",
      "minimum": 0,
      "maximum": 100,
      "description": "0–100. Higher finds more cuts; every 20 points halve the threshold. Default 60."
     },
     "minShotSeconds": {
      "type": "number",
      "minimum": 0.1,
      "maximum": 10,
      "description": "Shortest shot in seconds, 0.1–10. Default 0.6."
     }
    },
    "additionalProperties": false,
    "description": "Omitted fields use the defaults: adaptive, 60, 0.6 s."
   }
  },
  "required": [
   "sourceAssetId",
   "sourceHash"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "scene.request.get": {
  "type": "object",
  "properties": {},
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "scene.task.get": {
  "type": "object",
  "properties": {
   "taskId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "taskId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "scene.task.list": {
  "type": "object",
  "properties": {
   "sourceAssetId": {
    "type": "string",
    "format": "uuid"
   },
   "limit": {
    "type": "integer",
    "minimum": 1,
    "maximum": 50
   },
   "cursor": {
    "type": "string",
    "minLength": 1,
    "maxLength": 768
   }
  },
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "scene.task.cancel": {
  "type": "object",
  "properties": {
   "taskId": {
    "type": "string",
    "format": "uuid"
   },
   "expectedRevision": {
    "type": "integer",
    "minimum": 1,
    "maximum": 9007199254740991
   }
  },
  "required": [
   "taskId",
   "expectedRevision"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "scene.result.get": {
  "type": "object",
  "properties": {
   "assetId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "assetId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "scene.cuts.save": {
  "type": "object",
  "properties": {
   "assetId": {
    "type": "string",
    "format": "uuid"
   },
   "sourceHash": {
    "type": "string",
    "pattern": "^[a-f0-9]{64}$"
   },
   "expectedResultId": {
    "type": "string",
    "format": "uuid",
    "description": "The current result the edit starts from; a newer result conflicts."
   },
   "cuts": {
    "type": "array",
    "items": {
     "type": "integer",
     "minimum": 1,
     "maximum": 17999
    },
    "maxItems": 1500,
    "description": "Every cut after the edit: first frames of new shots on the 30 fps grid, strictly increasing, below the result frameCount."
   }
  },
  "required": [
   "assetId",
   "sourceHash",
   "expectedResultId",
   "cuts"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "scene.shots.create": {
  "type": "object",
  "properties": {
   "sourceAssetId": {
    "type": "string",
    "format": "uuid"
   },
   "sourceHash": {
    "type": "string",
    "pattern": "^[a-f0-9]{64}$"
   },
   "resultId": {
    "type": "string",
    "format": "uuid",
    "description": "The newest current result of this video; a newer or stale result is refused."
   },
   "segments": {
    "type": "array",
    "items": {
     "type": "integer",
     "minimum": 1,
     "maximum": 1501
    },
    "minItems": 1,
    "maxItems": 100,
    "description": "Segment numbers to build, from 1: segment n runs from cut n-1 (or the start) to cut n (or the end). Strictly increasing, at most 100."
   },
   "titlePrefix": {
    "type": "string",
    "minLength": 1,
    "maxLength": 40,
    "description": "Shot titles are \"<prefix> NN\" by segment number. Default 参考."
   },
   "position": {
    "type": "object",
    "properties": {
     "x": {
      "type": "number"
     },
     "y": {
      "type": "number"
     }
    },
    "required": [
     "x",
     "y"
    ],
    "additionalProperties": false,
    "description": "Canvas position of the first new shot; the rest follow in rows of six. Omitted places the batch below the existing canvas content."
   }
  },
  "required": [
   "sourceAssetId",
   "sourceHash",
   "resultId",
   "segments"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "scene.shots.undo": {
  "type": "object",
  "properties": {
   "taskId": {
    "type": "string",
    "format": "uuid"
   },
   "expectedRevision": {
    "type": "integer",
    "minimum": 1,
    "maximum": 9007199254740991
   }
  },
  "required": [
   "taskId",
   "expectedRevision"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "image.profile.list": {
  "type": "object",
  "properties": {
   "includeSettingsRevision": {
    "type": "boolean"
   }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "image.generate": {
  "anyOf": [
   {
    "type": "object",
    "properties": {
     "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
     },
     "providerId": {
      "type": "string",
      "enum": [
       "mock",
       "openai",
       "openai-compatible"
      ]
     },
     "model": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120,
      "pattern": "^[\\x21-\\x7e]+$"
     },
     "prompt": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
     },
     "options": {
      "type": "object",
      "properties": {
       "size": {
        "type": "string",
        "const": "1024x1024"
       },
       "quality": {
        "type": "string",
        "const": "low"
       },
       "outputFormat": {
        "type": "string",
        "const": "png"
       },
       "background": {
        "type": "string",
        "const": "opaque"
       },
       "n": {
        "type": "number",
        "const": 1
       }
      },
      "required": [
       "size",
       "quality",
       "outputFormat",
       "background",
       "n"
      ],
      "additionalProperties": false
     },
     "groupId": {
      "type": "string",
      "format": "uuid"
     },
     "expectedRevision": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
     }
    },
    "required": [
     "name",
     "providerId",
     "model",
     "prompt",
     "options"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
     },
     "providerId": {
      "type": "string",
      "const": "comfy-local"
     },
     "model": {
      "type": "string",
      "minLength": 1,
      "maxLength": 240
     },
     "prompt": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
     },
     "options": {
      "type": "object",
      "properties": {
       "size": {
        "type": "string",
        "const": "512x512"
       },
       "steps": {
        "type": "number",
        "const": 20
       },
       "cfg": {
        "type": "number",
        "const": 8
       },
       "sampler": {
        "type": "string",
        "const": "euler"
       },
       "scheduler": {
        "type": "string",
        "const": "normal"
       },
       "denoise": {
        "type": "number",
        "const": 1
       },
       "n": {
        "type": "number",
        "const": 1
       }
      },
      "required": [
       "size",
       "steps",
       "cfg",
       "sampler",
       "scheduler",
       "denoise",
       "n"
      ],
      "additionalProperties": false
     },
     "groupId": {
      "type": "string",
      "format": "uuid"
     },
     "expectedRevision": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
     }
    },
    "required": [
     "name",
     "providerId",
     "model",
     "prompt",
     "options"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
     },
     "providerId": {
      "type": "string",
      "enum": [
       "mock",
       "openai"
      ]
     },
     "model": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120,
      "pattern": "^[\\x21-\\x7e]+$"
     },
     "prompt": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
     },
     "options": {
      "type": "object",
      "properties": {
       "size": {
        "type": "string",
        "pattern": "^[1-9][0-9]{0,4}x[1-9][0-9]{0,4}$"
       },
       "quality": {
        "type": "string",
        "const": "low"
       },
       "outputFormat": {
        "type": "string",
        "const": "png"
       },
       "background": {
        "type": "string",
        "const": "opaque"
       },
       "n": {
        "type": "number",
        "const": 1
       }
      },
      "required": [
       "size",
       "quality",
       "outputFormat",
       "background",
       "n"
      ],
      "additionalProperties": false
     },
     "purpose": {
      "type": "string",
      "const": "edit"
     },
     "inputImage": {
      "type": "object",
      "properties": {
       "assetId": {
        "type": "string",
        "format": "uuid"
       },
       "sha256": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
       }
      },
      "required": [
       "assetId",
       "sha256"
      ],
      "additionalProperties": false
     },
     "groupId": {
      "type": "string",
      "format": "uuid"
     },
     "expectedRevision": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
     }
    },
    "required": [
     "name",
     "providerId",
     "model",
     "prompt",
     "options",
     "purpose",
     "inputImage"
    ],
    "additionalProperties": false
   }
  ],
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object"
 },
 "image.request.get": {
  "type": "object",
  "properties": {},
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "image.task.get": {
  "type": "object",
  "properties": {
   "taskId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "taskId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "image.task.list": {
  "type": "object",
  "properties": {
   "limit": {
    "type": "integer",
    "minimum": 1,
    "maximum": 50
   },
   "cursor": {
    "type": "string",
    "minLength": 1,
    "maxLength": 768
   },
   "groupId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "image.group.list": {
  "type": "object",
  "properties": {
   "limit": {
    "type": "integer",
    "minimum": 1,
    "maximum": 50
   },
   "cursor": {
    "type": "string",
    "minLength": 1,
    "maxLength": 768
   }
  },
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "image.group.get": {
  "type": "object",
  "properties": {
   "groupId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "groupId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "image.version.list": {
  "type": "object",
  "properties": {
   "limit": {
    "type": "integer",
    "minimum": 1,
    "maximum": 50
   },
   "cursor": {
    "type": "string",
    "minLength": 1,
    "maxLength": 768
   },
   "groupId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "groupId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "image.task.cancelQueued": {
  "type": "object",
  "properties": {
   "taskId": {
    "type": "string",
    "format": "uuid"
   },
   "expectedRevision": {
    "type": "integer",
    "minimum": 1,
    "maximum": 9007199254740991
   }
  },
  "required": [
   "taskId",
   "expectedRevision"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "image.task.recoverResult": {
  "type": "object",
  "properties": {
   "taskId": {
    "type": "string",
    "format": "uuid"
   },
   "expectedRevision": {
    "type": "integer",
    "minimum": 1,
    "maximum": 9007199254740991
   }
  },
  "required": [
   "taskId",
   "expectedRevision"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "image.review.prepare": {
  "type": "object",
  "properties": {
   "input": {
    "anyOf": [
     {
      "type": "object",
      "properties": {
       "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 120
       },
       "providerId": {
        "type": "string",
        "enum": [
         "mock",
         "openai",
         "openai-compatible"
        ]
       },
       "model": {
        "type": "string",
        "minLength": 1,
        "maxLength": 120,
        "pattern": "^[\\x21-\\x7e]+$"
       },
       "prompt": {
        "type": "string",
        "minLength": 1,
        "maxLength": 2000
       },
       "options": {
        "type": "object",
        "properties": {
         "size": {
          "type": "string",
          "const": "1024x1024"
         },
         "quality": {
          "type": "string",
          "const": "low"
         },
         "outputFormat": {
          "type": "string",
          "const": "png"
         },
         "background": {
          "type": "string",
          "const": "opaque"
         },
         "n": {
          "type": "number",
          "const": 1
         }
        },
        "required": [
         "size",
         "quality",
         "outputFormat",
         "background",
         "n"
        ],
        "additionalProperties": false
       },
       "groupId": {
        "type": "string",
        "format": "uuid"
       },
       "expectedRevision": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
       }
      },
      "required": [
       "name",
       "providerId",
       "model",
       "prompt",
       "options"
      ],
      "additionalProperties": false
     },
     {
      "type": "object",
      "properties": {
       "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 120
       },
       "providerId": {
        "type": "string",
        "const": "comfy-local"
       },
       "model": {
        "type": "string",
        "minLength": 1,
        "maxLength": 240
       },
       "prompt": {
        "type": "string",
        "minLength": 1,
        "maxLength": 2000
       },
       "options": {
        "type": "object",
        "properties": {
         "size": {
          "type": "string",
          "const": "512x512"
         },
         "steps": {
          "type": "number",
          "const": 20
         },
         "cfg": {
          "type": "number",
          "const": 8
         },
         "sampler": {
          "type": "string",
          "const": "euler"
         },
         "scheduler": {
          "type": "string",
          "const": "normal"
         },
         "denoise": {
          "type": "number",
          "const": 1
         },
         "n": {
          "type": "number",
          "const": 1
         }
        },
        "required": [
         "size",
         "steps",
         "cfg",
         "sampler",
         "scheduler",
         "denoise",
         "n"
        ],
        "additionalProperties": false
       },
       "groupId": {
        "type": "string",
        "format": "uuid"
       },
       "expectedRevision": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
       }
      },
      "required": [
       "name",
       "providerId",
       "model",
       "prompt",
       "options"
      ],
      "additionalProperties": false
     },
     {
      "type": "object",
      "properties": {
       "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 120
       },
       "providerId": {
        "type": "string",
        "enum": [
         "mock",
         "openai"
        ]
       },
       "model": {
        "type": "string",
        "minLength": 1,
        "maxLength": 120,
        "pattern": "^[\\x21-\\x7e]+$"
       },
       "prompt": {
        "type": "string",
        "minLength": 1,
        "maxLength": 2000
       },
       "options": {
        "type": "object",
        "properties": {
         "size": {
          "type": "string",
          "pattern": "^[1-9][0-9]{0,4}x[1-9][0-9]{0,4}$"
         },
         "quality": {
          "type": "string",
          "const": "low"
         },
         "outputFormat": {
          "type": "string",
          "const": "png"
         },
         "background": {
          "type": "string",
          "const": "opaque"
         },
         "n": {
          "type": "number",
          "const": 1
         }
        },
        "required": [
         "size",
         "quality",
         "outputFormat",
         "background",
         "n"
        ],
        "additionalProperties": false
       },
       "purpose": {
        "type": "string",
        "const": "edit"
       },
       "inputImage": {
        "type": "object",
        "properties": {
         "assetId": {
          "type": "string",
          "format": "uuid"
         },
         "sha256": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
         }
        },
        "required": [
         "assetId",
         "sha256"
        ],
        "additionalProperties": false
       },
       "groupId": {
        "type": "string",
        "format": "uuid"
       },
       "expectedRevision": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
       }
      },
      "required": [
       "name",
       "providerId",
       "model",
       "prompt",
       "options",
       "purpose",
       "inputImage"
      ],
      "additionalProperties": false
     }
    ]
   },
   "settingsRevision": {
    "type": "integer",
    "minimum": 1,
    "maximum": 9007199254740991
   }
  },
  "required": [
   "input",
   "settingsRevision"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "image.review.get": {
  "type": "object",
  "properties": {
   "reviewId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "reviewId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "image.review.list": {
  "type": "object",
  "properties": {
   "limit": {
    "type": "integer",
    "minimum": 1,
    "maximum": 50
   },
   "cursor": {
    "type": "string",
    "minLength": 1,
    "maxLength": 768
   }
  },
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "image.task.remote.get": {
  "type": "object",
  "properties": {
   "taskId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "taskId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "image.task.observeRemote": {
  "type": "object",
  "properties": {
   "taskId": {
    "type": "string",
    "format": "uuid"
   },
   "expectedRevision": {
    "type": "integer",
    "minimum": 1,
    "maximum": 9007199254740991
   }
  },
  "required": [
   "taskId",
   "expectedRevision"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "project.inspect": {
  "type": "object",
  "properties": {},
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "asset.inspect": {
  "type": "object",
  "properties": {
   "limit": {
    "type": "integer",
    "minimum": 1,
    "maximum": 25,
    "default": 10
   },
   "cursor": {
    "type": "string",
    "maxLength": 512
   }
  },
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "shot.inspect": {
  "type": "object",
  "properties": {
   "limit": {
    "type": "integer",
    "minimum": 1,
    "maximum": 25,
    "default": 10
   },
   "cursor": {
    "type": "string",
    "maxLength": 512
   }
  },
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.inspect": {
  "type": "object",
  "properties": {},
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "subject.create": {
  "type": "object",
  "properties": {
   "kind": {
    "type": "string",
    "enum": [
     "character",
     "product",
     "location",
     "look"
    ]
   },
   "name": {
    "type": "string",
    "minLength": 1,
    "maxLength": 120
   },
   "assetId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "kind",
   "name",
   "assetId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "subject.version.add": {
  "type": "object",
  "properties": {
   "subjectId": {
    "type": "string",
    "format": "uuid"
   },
   "expectedRevision": {
    "type": "integer",
    "minimum": 1,
    "maximum": 9007199254740991
   },
   "assetId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "subjectId",
   "expectedRevision",
   "assetId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "subject.binding.set": {
  "type": "object",
  "properties": {
   "shotId": {
    "type": "string",
    "format": "uuid"
   },
   "subjectId": {
    "type": "string",
    "format": "uuid"
   },
   "role": {
    "type": "string",
    "enum": [
     "subject",
     "style"
    ]
   },
   "subjectVersionId": {
    "anyOf": [
     {
      "type": "string",
      "format": "uuid"
     },
     {
      "type": "null"
     }
    ]
   },
   "expectedRevision": {
    "type": "integer",
    "minimum": 0,
    "maximum": 9007199254740991
   },
   "expectedSubjectRevision": {
    "type": "integer",
    "minimum": 1,
    "maximum": 9007199254740991
   }
  },
  "required": [
   "shotId",
   "subjectId",
   "role",
   "subjectVersionId",
   "expectedRevision",
   "expectedSubjectRevision"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "subject.list": {
  "type": "object",
  "properties": {
   "limit": {
    "type": "integer",
    "minimum": 1,
    "maximum": 50
   },
   "cursor": {
    "type": "string",
    "minLength": 1,
    "maxLength": 768
   }
  },
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "subject.version.list": {
  "type": "object",
  "properties": {
   "limit": {
    "type": "integer",
    "minimum": 1,
    "maximum": 50
   },
   "cursor": {
    "type": "string",
    "minLength": 1,
    "maxLength": 768
   },
   "subjectId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "subjectId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "subject.binding.list": {
  "type": "object",
  "properties": {
   "limit": {
    "type": "integer",
    "minimum": 1,
    "maximum": 50
   },
   "cursor": {
    "type": "string",
    "minLength": 1,
    "maxLength": 768
   },
   "shotId": {
    "type": "string",
    "format": "uuid"
   },
   "subjectId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "subject.variants.create": {
  "type": "object",
  "properties": {
   "subjectId": {
    "type": "string",
    "format": "uuid"
   },
   "sourceVersionId": {
    "type": "string",
    "format": "uuid"
   },
   "kind": {
    "type": "string",
    "enum": [
     "angle",
     "light"
    ]
   },
   "items": {
    "type": "array",
    "items": {
     "anyOf": [
      {
       "type": "object",
       "properties": {
        "kind": {
         "type": "string",
         "const": "angle"
        },
        "position": {
         "type": "string",
         "enum": [
          "front",
          "front-left",
          "left",
          "back-left",
          "back",
          "back-right",
          "right",
          "front-right",
          "high",
          "low"
         ]
        },
        "focal": {
         "type": "string",
         "enum": [
          "standard",
          "wide"
         ]
        }
       },
       "required": [
        "kind",
        "position",
        "focal"
       ],
       "additionalProperties": false
      },
      {
       "type": "object",
       "properties": {
        "kind": {
         "type": "string",
         "const": "light"
        },
        "azimuth": {
         "type": "integer",
         "minimum": -180,
         "maximum": 180
        },
        "elevation": {
         "type": "integer",
         "minimum": -90,
         "maximum": 90
        },
        "quality": {
         "type": "string",
         "enum": [
          "soft",
          "hard",
          "back"
         ]
        },
        "kelvin": {
         "type": "integer",
         "minimum": 2000,
         "maximum": 10000,
         "multipleOf": 100
        }
       },
       "required": [
        "kind",
        "azimuth",
        "elevation",
        "quality",
        "kelvin"
       ],
       "additionalProperties": false
      }
     ]
    },
    "minItems": 1,
    "maxItems": 8
   },
   "providerId": {
    "type": "string",
    "enum": [
     "mock",
     "openai"
    ]
   },
   "model": {
    "type": "string",
    "minLength": 1,
    "maxLength": 100
   }
  },
  "required": [
   "subjectId",
   "sourceVersionId",
   "kind",
   "items",
   "providerId",
   "model"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "subject.variants.retry": {
  "type": "object",
  "properties": {
   "batchId": {
    "type": "string",
    "format": "uuid"
   },
   "position": {
    "type": "integer",
    "minimum": 1,
    "maximum": 8
   },
   "expectedRevision": {
    "type": "integer",
    "minimum": 1,
    "maximum": 9007199254740991
   }
  },
  "required": [
   "batchId",
   "position",
   "expectedRevision"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "subject.variants.undo": {
  "type": "object",
  "properties": {
   "batchId": {
    "type": "string",
    "format": "uuid"
   },
   "expectedRevision": {
    "type": "integer",
    "minimum": 1,
    "maximum": 9007199254740991
   }
  },
  "required": [
   "batchId",
   "expectedRevision"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "subject.variants.get": {
  "type": "object",
  "properties": {
   "batchId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "batchId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "subject.variants.list": {
  "type": "object",
  "properties": {
   "subjectId": {
    "type": "string",
    "format": "uuid"
   },
   "limit": {
    "type": "integer",
    "minimum": 1,
    "maximum": 50
   },
   "cursor": {
    "type": "string",
    "minLength": 1,
    "maxLength": 768
   }
  },
  "required": [
   "subjectId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "previs.create": {
  "type": "object",
  "properties": {
   "label": {
    "type": "string",
    "maxLength": 150
   },
   "position": {
    "type": "object",
    "properties": {
     "x": {
      "type": "number"
     },
     "y": {
      "type": "number"
     }
    },
    "required": [
     "x",
     "y"
    ],
    "additionalProperties": false
   }
  },
  "required": [
   "position"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "previs.scene.set": {
  "type": "object",
  "properties": {
   "nodeId": {
    "type": "string",
    "format": "uuid"
   },
   "expectedSceneRevision": {
    "type": "integer",
    "minimum": 1,
    "maximum": 9007199254740991
   },
   "scene": {
    "type": "object",
    "properties": {
     "schemaVersion": {
      "type": "number",
      "const": 1
     },
     "figures": {
      "type": "array",
      "items": {
       "type": "object",
       "properties": {
        "id": {
         "type": "string",
         "pattern": "^f[1-9][0-9]{0,3}$"
        },
        "name": {
         "type": "string",
         "maxLength": 20,
         "pattern": "^[^\\u0000-\\u001f\\u007f-\\u009f\\ud800-\\udfff]*$"
        },
        "visible": {
         "type": "boolean"
        },
        "position": {
         "type": "array",
         "minItems": 3,
         "maxItems": 3,
         "items": [
          {
           "type": "number",
           "minimum": -100,
           "maximum": 100
          },
          {
           "type": "number",
           "minimum": -100,
           "maximum": 100
          },
          {
           "type": "number",
           "minimum": -100,
           "maximum": 100
          }
         ]
        },
        "rotation": {
         "type": "number",
         "minimum": -180,
         "maximum": 180
        },
        "pose": {
         "type": "string",
         "enum": [
          "stand",
          "walk",
          "sit",
          "hold",
          "look-back"
         ]
        },
        "held": {
         "anyOf": [
          {
           "type": "object",
           "properties": {
            "propId": {
             "type": "string",
             "pattern": "^p[1-9][0-9]{0,3}$"
            },
            "hand": {
             "type": "string",
             "enum": [
              "left",
              "right"
             ]
            }
           },
           "required": [
            "propId",
            "hand"
           ],
           "additionalProperties": false
          },
          {
           "type": "null"
          }
         ]
        },
        "subject": {
         "type": "object",
         "properties": {
          "subjectId": {
           "type": "string",
           "format": "uuid"
          },
          "subjectVersionId": {
           "type": "string",
           "format": "uuid"
          }
         },
         "required": [
          "subjectId"
         ],
         "additionalProperties": false
        }
       },
       "required": [
        "id",
        "name",
        "visible",
        "position",
        "rotation",
        "pose",
        "held"
       ],
       "additionalProperties": false
      },
      "maxItems": 8
     },
     "props": {
      "type": "array",
      "items": {
       "type": "object",
       "properties": {
        "id": {
         "type": "string",
         "pattern": "^p[1-9][0-9]{0,3}$"
        },
        "kind": {
         "type": "string",
         "enum": [
          "box",
          "cylinder",
          "sphere",
          "panel",
          "umbrella",
          "phone",
          "bag",
          "cup"
         ]
        },
        "name": {
         "type": "string",
         "maxLength": 20,
         "pattern": "^[^\\u0000-\\u001f\\u007f-\\u009f\\ud800-\\udfff]*$"
        },
        "visible": {
         "type": "boolean"
        },
        "position": {
         "type": "array",
         "minItems": 3,
         "maxItems": 3,
         "items": [
          {
           "type": "number",
           "minimum": -100,
           "maximum": 100
          },
          {
           "type": "number",
           "minimum": -100,
           "maximum": 100
          },
          {
           "type": "number",
           "minimum": -100,
           "maximum": 100
          }
         ]
        },
        "rotation": {
         "type": "number",
         "minimum": -180,
         "maximum": 180
        },
        "size": {
         "type": "array",
         "minItems": 3,
         "maxItems": 3,
         "items": [
          {
           "type": "number",
           "minimum": 0.01,
           "maximum": 20
          },
          {
           "type": "number",
           "minimum": 0.01,
           "maximum": 20
          },
          {
           "type": "number",
           "minimum": 0.01,
           "maximum": 20
          }
         ]
        },
        "subject": {
         "type": "object",
         "properties": {
          "subjectId": {
           "type": "string",
           "format": "uuid"
          },
          "subjectVersionId": {
           "type": "string",
           "format": "uuid"
          }
         },
         "required": [
          "subjectId"
         ],
         "additionalProperties": false
        }
       },
       "required": [
        "id",
        "kind",
        "name",
        "visible",
        "position",
        "rotation",
        "size"
       ],
       "additionalProperties": false
      },
      "maxItems": 24
     },
     "light": {
      "type": "object",
      "properties": {
       "visible": {
        "type": "boolean"
       },
       "azimuth": {
        "type": "number",
        "minimum": -180,
        "maximum": 180
       },
       "elevation": {
        "type": "number",
        "minimum": -90,
        "maximum": 90
       },
       "intensity": {
        "type": "number",
        "minimum": 0,
        "maximum": 4
       }
      },
      "required": [
       "visible",
       "azimuth",
       "elevation",
       "intensity"
      ],
      "additionalProperties": false
     },
     "camera": {
      "type": "object",
      "properties": {
       "position": {
        "type": "array",
        "minItems": 3,
        "maxItems": 3,
        "items": [
         {
          "type": "number",
          "minimum": -100,
          "maximum": 100
         },
         {
          "type": "number",
          "minimum": -100,
          "maximum": 100
         },
         {
          "type": "number",
          "minimum": -100,
          "maximum": 100
         }
        ]
       },
       "yaw": {
        "type": "number",
        "minimum": -180,
        "maximum": 180
       },
       "pitch": {
        "type": "number",
        "minimum": -90,
        "maximum": 90
       },
       "focalLength": {
        "type": "number",
        "minimum": 10,
        "maximum": 300
       }
      },
      "required": [
       "position",
       "yaw",
       "pitch",
       "focalLength"
      ],
      "additionalProperties": false
     },
     "keyframes": {
      "type": "array",
      "items": {
       "type": "object",
       "properties": {
        "id": {
         "type": "string",
         "pattern": "^k[1-9][0-9]{0,3}$"
        },
        "name": {
         "type": "string",
         "maxLength": 20,
         "pattern": "^[^\\u0000-\\u001f\\u007f-\\u009f\\ud800-\\udfff]*$"
        },
        "camera": {
         "type": "object",
         "properties": {
          "position": {
           "type": "array",
           "minItems": 3,
           "maxItems": 3,
           "items": [
            {
             "type": "number",
             "minimum": -100,
             "maximum": 100
            },
            {
             "type": "number",
             "minimum": -100,
             "maximum": 100
            },
            {
             "type": "number",
             "minimum": -100,
             "maximum": 100
            }
           ]
          },
          "yaw": {
           "type": "number",
           "minimum": -180,
           "maximum": 180
          },
          "pitch": {
           "type": "number",
           "minimum": -90,
           "maximum": 90
          },
          "focalLength": {
           "type": "number",
           "minimum": 10,
           "maximum": 300
          }
         },
         "required": [
          "position",
          "yaw",
          "pitch",
          "focalLength"
         ],
         "additionalProperties": false
        },
        "exports": {
         "type": "array",
         "items": {
          "type": "string",
          "format": "uuid"
         },
         "maxItems": 4
        }
       },
       "required": [
        "id",
        "name",
        "camera",
        "exports"
       ],
       "additionalProperties": false
      },
      "maxItems": 24
     },
     "activeKeyframeId": {
      "anyOf": [
       {
        "type": "string",
        "pattern": "^k[1-9][0-9]{0,3}$"
       },
       {
        "type": "null"
       }
      ]
     }
    },
    "required": [
     "schemaVersion",
     "figures",
     "props",
     "light",
     "camera",
     "keyframes",
     "activeKeyframeId"
    ],
    "additionalProperties": false
   }
  },
  "required": [
   "nodeId",
   "expectedSceneRevision",
   "scene"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "previs.thumbnail.set": {
  "type": "object",
  "properties": {
   "nodeId": {
    "type": "string",
    "format": "uuid"
   },
   "slot": {
    "type": "string",
    "pattern": "^(?:card|k[1-9][0-9]{0,3})$"
   },
   "sceneRevision": {
    "type": "integer",
    "minimum": 1,
    "maximum": 9007199254740991
   },
   "dataBase64": {
    "type": "string",
    "minLength": 4,
    "maxLength": 87384,
    "pattern": "^[A-Za-z0-9+/]+={0,2}$"
   }
  },
  "required": [
   "nodeId",
   "slot",
   "sceneRevision",
   "dataBase64"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "previs.thumbnail.get": {
  "type": "object",
  "properties": {
   "nodeId": {
    "type": "string",
    "format": "uuid"
   },
   "slots": {
    "type": "array",
    "items": {
     "type": "string",
     "pattern": "^(?:card|k[1-9][0-9]{0,3})$"
    },
    "minItems": 1,
    "maxItems": 25
   }
  },
  "required": [
   "nodeId",
   "slots"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "asset.range.get": {
  "type": "object",
  "properties": {
   "assetId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "assetId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "asset.range.set": {
  "type": "object",
  "properties": {
   "assetId": {
    "type": "string",
    "format": "uuid"
   },
   "expectedRevision": {
    "type": "integer",
    "minimum": 0,
    "maximum": 9007199254740991,
    "description": "Source-range revision, starting at 0 when no range has been saved. Independent of project, asset and timeline revisions."
   },
   "inFrame": {
    "type": "integer",
    "minimum": 0,
    "maximum": 9007199254740991,
    "description": "Inclusive source in point in the 30fps timeline timebase; not a native/VFR frame index."
   },
   "outFrame": {
    "type": "integer",
    "minimum": 0,
    "maximum": 9007199254740991,
    "description": "Exclusive source out point in the 30fps timeline timebase; greater than inFrame and no greater than sourceFrameCount."
   }
  },
  "required": [
   "assetId",
   "expectedRevision",
   "inFrame",
   "outFrame"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "asset.disposition.list": {
  "type": "object",
  "properties": {
   "assetIds": {
    "type": "array",
    "items": {
     "type": "string",
     "format": "uuid"
    },
    "minItems": 1,
    "maxItems": 100,
    "description": "Explicit ordered batch of 1–100 unique existing asset IDs. All assets must belong to the project; missing or foreign assets fail the entire batch. No rows are created."
   }
  },
  "required": [
   "assetIds"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "asset.disposition.set": {
  "type": "object",
  "properties": {
   "assetId": {
    "type": "string",
    "format": "uuid"
   },
   "expectedRevision": {
    "type": "integer",
    "minimum": 0,
    "maximum": 9007199254740991,
    "description": "Independent disposition revision. A successful list confirms revision 0 and neutral when no disposition has been saved."
   },
   "disposition": {
    "type": "string",
    "enum": [
     "neutral",
     "favorite",
     "rejected"
    ],
    "description": "Shared metadata only. Neutral resets the label while retaining its revision history; rejected never deletes or hides an asset from the backend."
   }
  },
  "required": [
   "assetId",
   "expectedRevision",
   "disposition"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "asset.annotation.list": {
  "type": "object",
  "properties": {
   "assetIds": {
    "type": "array",
    "items": {
     "type": "string",
     "format": "uuid"
    },
    "minItems": 1,
    "maxItems": 100
   }
  },
  "required": [
   "assetIds"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "asset.annotation.set": {
  "type": "object",
  "properties": {
   "assetId": {
    "type": "string",
    "format": "uuid"
   },
   "expectedRevision": {
    "type": "integer",
    "minimum": 0,
    "maximum": 9007199254740991
   },
   "tags": {
    "type": "array",
    "items": {
     "type": "string",
     "minLength": 1
    },
    "maxItems": 20
   },
   "note": {
    "type": "string"
   }
  },
  "required": [
   "assetId",
   "expectedRevision",
   "tags",
   "note"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "asset.waveform.request": {
  "type": "object",
  "properties": {
   "assetId": {
    "type": "string",
    "format": "uuid"
   },
   "retry": {
    "type": "boolean",
    "default": false,
    "description": "Explicitly retry an interrupted or failed attempt. Ordinary repeats reuse queued, running or ready cache work. No durable mutation replay key is used; an evicted cache may be rebuilt."
   }
  },
  "required": [
   "assetId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "asset.waveform.get": {
  "type": "object",
  "properties": {
   "assetId": {
    "type": "string",
    "format": "uuid"
   },
   "sourceStartFrame": {
    "type": "integer",
    "minimum": 0,
    "maximum": 17999,
    "default": 0,
    "description": "Inclusive source position in the 30fps editing timebase, not a native/VFR frame index. Reading never starts or repairs waveform work."
   },
   "sourceEndFrame": {
    "type": "integer",
    "minimum": 1,
    "maximum": 18000,
    "description": "Exclusive source position; defaults to the available source end and must be greater than sourceStartFrame."
   },
   "points": {
    "type": "integer",
    "minimum": 1,
    "maximum": 2048,
    "default": 512,
    "description": "Maximum returned source peak count. Null bins indicate missing decoded coverage; numeric values are normalized absolute amplitudes from the first audio stream, before timeline gain, mute or fades."
   }
  },
  "required": [
   "assetId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.export.preflight": {
  "type": "object",
  "properties": {
   "exportSettings": {
    "anyOf": [
     {
      "type": "object",
      "properties": {
       "profileId": {
        "type": "string",
        "const": "mp4_h264_v1"
       },
       "resolution": {
        "type": "string",
        "enum": [
         "native",
         "short_360",
         "short_720",
         "short_1080"
        ]
       },
       "rateControl": {
        "anyOf": [
         {
          "type": "object",
          "properties": {
           "mode": {
            "type": "string",
            "const": "crf"
           },
           "quality": {
            "type": "string",
            "enum": [
             "compact",
             "standard",
             "high"
            ]
           }
          },
          "required": [
           "mode",
           "quality"
          ],
          "additionalProperties": false
         },
         {
          "type": "object",
          "properties": {
           "mode": {
            "type": "string",
            "const": "bitrate"
           },
           "targetKbps": {
            "type": "number",
            "enum": [
             2000,
             4000,
             8000
            ]
           }
          },
          "required": [
           "mode",
           "targetKbps"
          ],
          "additionalProperties": false
         }
        ]
       }
      },
      "required": [
       "profileId",
       "resolution",
       "rateControl"
      ],
      "additionalProperties": false
     },
     {
      "type": "object",
      "properties": {
       "profileId": {
        "type": "string",
        "const": "mp4_h264_float_checked_v2"
       },
       "resolution": {
        "type": "string",
        "enum": [
         "native",
         "short_360",
         "short_720",
         "short_1080"
        ]
       },
       "rateControl": {
        "anyOf": [
         {
          "type": "object",
          "properties": {
           "mode": {
            "type": "string",
            "const": "crf"
           },
           "quality": {
            "type": "string",
            "enum": [
             "compact",
             "standard",
             "high"
            ]
           }
          },
          "required": [
           "mode",
           "quality"
          ],
          "additionalProperties": false
         },
         {
          "type": "object",
          "properties": {
           "mode": {
            "type": "string",
            "const": "bitrate"
           },
           "targetKbps": {
            "type": "number",
            "enum": [
             2000,
             4000,
             8000
            ]
           }
          },
          "required": [
           "mode",
           "targetKbps"
          ],
          "additionalProperties": false
         }
        ]
       }
      },
      "required": [
       "profileId",
       "resolution",
       "rateControl"
      ],
      "additionalProperties": false,
      "description": "Explicit export-only float intermediate profile. The complete pre-encode sample peak must not exceed one; otherwise the export fails without publishing an asset. No automatic gain change. This is not an AAC or true-peak safety guarantee."
     }
    ]
   },
   "deliveryName": {
    "type": "string",
    "minLength": 1,
    "maxLength": 120,
    "allOf": [
     {
      "pattern": "\\S"
     },
     {
      "pattern": "^[^\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+$(?![\\s\\S])"
     },
     {
      "pattern": "^(?:[^\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])*$"
     }
    ]
   },
   "exportRange": {
    "type": "object",
    "properties": {
     "startFrame": {
      "type": "integer",
      "minimum": 0,
      "maximum": 17999,
      "description": "Included start frame on the saved composition clock, fixed at 30fps."
     },
     "endFrame": {
      "type": "integer",
      "minimum": 1,
      "maximum": 18000,
      "description": "Excluded end frame on the same 30fps composition clock. Must exceed startFrame; fresh export acceptance requires it not exceed the current saved timeline duration."
     }
    },
    "required": [
     "startFrame",
     "endFrame"
    ],
    "additionalProperties": false,
    "description": "Export-only half-open [startFrame,endFrame) range on the saved 30fps composition. At least one frame; bounded by the saved timeline. Omission preserves full export."
   },
   "expectedRevision": {
    "type": "integer",
    "exclusiveMinimum": 0,
    "description": "Existing timeline revision to check. This read never creates a timeline; a different current revision is reported as stale."
   }
  },
  "required": [
   "expectedRevision"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.export.samplePeak": {
  "type": "object",
  "properties": {
   "exportId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "exportId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.export.loudness": {
  "type": "object",
  "properties": {
   "exportId": {
    "type": "string",
    "format": "uuid"
   },
   "expectedArtifactSha256": {
    "type": "string",
    "pattern": "^[a-f0-9]{64}$"
   },
   "measurementProfile": {
    "type": "string",
    "const": "bs1770-5-48k-stereo-fir4x-v1"
   },
   "target": {
    "type": "object",
    "properties": {
     "integratedLufs": {
      "type": "number",
      "minimum": -60,
      "maximum": -5
     },
     "truePeakCeilingDbtp": {
      "type": "number",
      "minimum": -20,
      "maximum": 0
     }
    },
    "required": [
     "integratedLufs",
     "truePeakCeilingDbtp"
    ],
    "additionalProperties": false
   }
  },
  "required": [
   "exportId",
   "expectedArtifactSha256",
   "measurementProfile"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.loudness.prepare": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "minimum": 1,
    "maximum": 9007199254740991
   },
   "mixProfile": {
    "type": "string",
    "const": "timeline-float-mix-v1"
   },
   "measurementProfile": {
    "type": "string",
    "const": "bs1770-5-48k-stereo-fir4x-v1"
   },
   "target": {
    "type": "object",
    "properties": {
     "integratedLufs": {
      "type": "number",
      "minimum": -60,
      "maximum": -5
     },
     "truePeakCeilingDbtp": {
      "type": "number",
      "minimum": -20,
      "maximum": 0
     }
    },
    "required": [
     "integratedLufs",
     "truePeakCeilingDbtp"
    ],
    "additionalProperties": false
   }
  },
  "required": [
   "expectedRevision",
   "mixProfile",
   "measurementProfile",
   "target"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.clip.loudness": {
  "type": "object",
  "properties": {
   "timelineId": {
    "type": "string",
    "format": "uuid",
    "minLength": 36,
    "maxLength": 36
   },
   "expectedRevision": {
    "type": "integer",
    "minimum": 1,
    "maximum": 9007199254740991
   },
   "clipId": {
    "type": "string",
    "format": "uuid",
    "minLength": 36,
    "maxLength": 36
   },
   "expectedAssetSha256": {
    "type": "string",
    "minLength": 64,
    "maxLength": 64,
    "pattern": "^[a-f0-9]{64}$"
   },
   "measurementProfile": {
    "type": "string",
    "const": "bs1770-5-48k-stereo-fir4x-v1"
   },
   "target": {
    "type": "object",
    "properties": {
     "integratedLufs": {
      "type": "number",
      "minimum": -60,
      "maximum": -5
     },
     "truePeakCeilingDbtp": {
      "type": "number",
      "minimum": -20,
      "maximum": 0
     }
    },
    "required": [
     "integratedLufs",
     "truePeakCeilingDbtp"
    ],
    "additionalProperties": false
   }
  },
  "required": [
   "timelineId",
   "expectedRevision",
   "clipId",
   "expectedAssetSha256",
   "measurementProfile"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.loudness.apply": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "minimum": 1,
    "maximum": 9007199254740991
   },
   "mixProfile": {
    "type": "string",
    "const": "timeline-float-mix-v1"
   },
   "measurementProfile": {
    "type": "string",
    "const": "bs1770-5-48k-stereo-fir4x-v1"
   },
   "target": {
    "type": "object",
    "properties": {
     "integratedLufs": {
      "type": "number",
      "minimum": -60,
      "maximum": -5
     },
     "truePeakCeilingDbtp": {
      "type": "number",
      "minimum": -20,
      "maximum": 0
     }
    },
    "required": [
     "integratedLufs",
     "truePeakCeilingDbtp"
    ],
    "additionalProperties": false
   },
   "snapshotSha256": {
    "type": "string",
    "pattern": "^[a-f0-9]{64}$"
   },
   "candidateDigest": {
    "type": "string",
    "pattern": "^timeline-loudness-candidate-v1:[a-f0-9]{64}$"
   }
  },
  "required": [
   "expectedRevision",
   "mixProfile",
   "measurementProfile",
   "target",
   "snapshotSha256",
   "candidateDigest"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.clip.refreshSources": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "exclusiveMinimum": 0
   },
   "clipIds": {
    "type": "array",
    "items": {
     "type": "string",
     "format": "uuid"
    },
    "minItems": 1,
    "maxItems": 100
   }
  },
  "required": [
   "expectedRevision",
   "clipIds"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.shots.append": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "exclusiveMinimum": 0
   }
  },
  "required": [
   "expectedRevision"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.clip.splitAtScenes": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "exclusiveMinimum": 0
   },
   "assetId": {
    "type": "string",
    "format": "uuid",
    "description": "The reference video whose clips are split."
   },
   "resultId": {
    "type": "string",
    "format": "uuid",
    "description": "Its current scene result (scene.result.get); a newer or stale result conflicts."
   }
  },
  "required": [
   "expectedRevision",
   "assetId",
   "resultId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.clip.crossfade": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "exclusiveMinimum": 0
   },
   "outgoingClipId": {
    "type": "string",
    "format": "uuid",
    "description": "The earlier clip, which fades out over the overlap."
   },
   "incomingClipId": {
    "type": "string",
    "format": "uuid",
    "description": "The later clip on another track, which fades in over the overlap."
   }
  },
  "required": [
   "expectedRevision",
   "outgoingClipId",
   "incomingClipId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.clip.setGains": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "exclusiveMinimum": 0
   },
   "gains": {
    "type": "array",
    "items": {
     "type": "object",
     "properties": {
      "clipId": {
       "type": "string",
       "format": "uuid"
      },
      "gain": {
       "type": "number",
       "minimum": 0,
       "maximum": 2,
       "description": "The new linear gain of the clip, 0 to 2."
      }
     },
     "required": [
      "clipId",
      "gain"
     ],
     "additionalProperties": false
    },
    "minItems": 1,
    "maxItems": 100
   }
  },
  "required": [
   "expectedRevision",
   "gains"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.clip.setTransform": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "exclusiveMinimum": 0
   },
   "clipId": {
    "type": "string",
    "format": "uuid"
   },
   "transform": {
    "anyOf": [
     {
      "type": "object",
      "properties": {
       "profileId": {
        "type": "string",
        "const": "mioon-clip-transform-v1"
       },
       "keyframes": {
        "type": "array",
        "items": {
         "type": "object",
         "properties": {
          "frame": {
           "type": "integer",
           "minimum": 0,
           "maximum": 18000,
           "description": "Clip-local frame; at most the clip duration."
          },
          "x": {
           "type": "number",
           "minimum": -8192,
           "maximum": 8192,
           "description": "Horizontal or vertical offset of the content centre from the clip rectangle centre in timeline pixels (x)."
          },
          "y": {
           "type": "number",
           "minimum": -8192,
           "maximum": 8192,
           "description": "Horizontal or vertical offset of the content centre from the clip rectangle centre in timeline pixels (y)."
          },
          "scale": {
           "type": "number",
           "minimum": 0.05,
           "maximum": 8,
           "description": "Multiplier of the size the source has after fitting the clip rectangle."
          }
         },
         "required": [
          "frame",
          "x",
          "y",
          "scale"
         ],
         "additionalProperties": false
        },
        "minItems": 1,
        "maxItems": 16
       },
       "rotation": {
        "type": "number",
        "minimum": -180,
        "maximum": 180,
        "description": "Static clockwise degrees around the content centre."
       },
       "crop": {
        "type": "object",
        "properties": {
         "left": {
          "type": "number",
          "minimum": 0,
          "maximum": 0.9
         },
         "top": {
          "type": "number",
          "minimum": 0,
          "maximum": 0.9
         },
         "right": {
          "type": "number",
          "minimum": 0,
          "maximum": 0.9
         },
         "bottom": {
          "type": "number",
          "minimum": 0,
          "maximum": 0.9
         }
        },
        "required": [
         "left",
         "top",
         "right",
         "bottom"
        ],
        "additionalProperties": false
       }
      },
      "required": [
       "profileId",
       "keyframes",
       "rotation",
       "crop"
      ],
      "additionalProperties": false
     },
     {
      "type": "null"
     }
    ],
    "description": "The new transform, or null to remove it."
   }
  },
  "required": [
   "expectedRevision",
   "clipId",
   "transform"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.clip.setTransition": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "exclusiveMinimum": 0
   },
   "clipId": {
    "type": "string",
    "format": "uuid",
    "description": "The incoming clip: the cut is where it starts."
   },
   "transition": {
    "anyOf": [
     {
      "type": "object",
      "properties": {
       "profileId": {
        "type": "string",
        "const": "mioon-clip-transition-v1"
       },
       "kind": {
        "type": "string",
        "enum": [
         "dissolve",
         "dipToBlack",
         "wipeLeft",
         "wipeRight",
         "pushLeft",
         "pushRight"
        ],
        "description": "dissolve, dipToBlack, wipeLeft, wipeRight, pushLeft or pushRight."
       },
       "durationFrames": {
        "type": "integer",
        "minimum": 2,
        "maximum": 60,
        "description": "Timeline frames, centred on the cut: half before it from the incoming clip, the rest after it from the outgoing clip."
       }
      },
      "required": [
       "profileId",
       "kind",
       "durationFrames"
      ],
      "additionalProperties": false
     },
     {
      "type": "null"
     }
    ],
    "description": "The new transition, or null to remove it."
   }
  },
  "required": [
   "expectedRevision",
   "clipId",
   "transition"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.audioPreview.plan": {
  "type": "object",
  "properties": {
   "timelineId": {
    "type": "string",
    "format": "uuid"
   },
   "expectedRevision": {
    "type": "integer",
    "minimum": 1,
    "maximum": 9007199254740991
   },
   "startFrame": {
    "type": "integer",
    "minimum": 0,
    "maximum": 17999
   }
  },
  "required": [
   "timelineId",
   "expectedRevision",
   "startFrame"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.audioPreview.continuousPlan": {
  "type": "object",
  "properties": {
   "timelineId": {
    "type": "string",
    "format": "uuid"
   },
   "expectedRevision": {
    "type": "integer",
    "minimum": 1,
    "maximum": 9007199254740991
   },
   "startFrame": {
    "type": "integer",
    "minimum": 0,
    "maximum": 17999
   }
  },
  "required": [
   "timelineId",
   "expectedRevision",
   "startFrame"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.export.capabilities": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "minimum": 1,
    "maximum": 9007199254740991
   },
   "exportSettings": {
    "anyOf": [
     {
      "type": "object",
      "properties": {
       "profileId": {
        "type": "string",
        "const": "mp4_h264_v1"
       },
       "resolution": {
        "type": "string",
        "enum": [
         "native",
         "short_360",
         "short_720",
         "short_1080"
        ]
       },
       "rateControl": {
        "anyOf": [
         {
          "type": "object",
          "properties": {
           "mode": {
            "type": "string",
            "const": "crf"
           },
           "quality": {
            "type": "string",
            "enum": [
             "compact",
             "standard",
             "high"
            ]
           }
          },
          "required": [
           "mode",
           "quality"
          ],
          "additionalProperties": false
         },
         {
          "type": "object",
          "properties": {
           "mode": {
            "type": "string",
            "const": "bitrate"
           },
           "targetKbps": {
            "type": "number",
            "enum": [
             2000,
             4000,
             8000
            ]
           }
          },
          "required": [
           "mode",
           "targetKbps"
          ],
          "additionalProperties": false
         }
        ]
       }
      },
      "required": [
       "profileId",
       "resolution",
       "rateControl"
      ],
      "additionalProperties": false
     },
     {
      "type": "object",
      "properties": {
       "profileId": {
        "type": "string",
        "const": "mp4_h264_float_checked_v2"
       },
       "resolution": {
        "type": "string",
        "enum": [
         "native",
         "short_360",
         "short_720",
         "short_1080"
        ]
       },
       "rateControl": {
        "anyOf": [
         {
          "type": "object",
          "properties": {
           "mode": {
            "type": "string",
            "const": "crf"
           },
           "quality": {
            "type": "string",
            "enum": [
             "compact",
             "standard",
             "high"
            ]
           }
          },
          "required": [
           "mode",
           "quality"
          ],
          "additionalProperties": false
         },
         {
          "type": "object",
          "properties": {
           "mode": {
            "type": "string",
            "const": "bitrate"
           },
           "targetKbps": {
            "type": "number",
            "enum": [
             2000,
             4000,
             8000
            ]
           }
          },
          "required": [
           "mode",
           "targetKbps"
          ],
          "additionalProperties": false
         }
        ]
       }
      },
      "required": [
       "profileId",
       "resolution",
       "rateControl"
      ],
      "additionalProperties": false,
      "description": "Explicit export-only float intermediate profile. The complete pre-encode sample peak must not exceed one; otherwise the export fails without publishing an asset. No automatic gain change. This is not an AAC or true-peak safety guarantee."
     }
    ]
   }
  },
  "required": [
   "expectedRevision",
   "exportSettings"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "project.create": {
  "type": "object",
  "properties": {
   "name": {
    "type": "string",
    "minLength": 1,
    "maxLength": 150
   },
   "description": {
    "type": "string",
    "maxLength": 2000
   },
   "timelinePresetId": {
    "type": "string",
    "enum": [
     "portrait_1080",
     "landscape_1080",
     "square_1080"
    ]
   }
  },
  "required": [
   "name"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "project.list": {
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "project.get": {
  "type": "object",
  "properties": {},
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "asset.import": {
  "type": "object",
  "properties": {
   "name": {
    "type": "string",
    "minLength": 1,
    "maxLength": 200
   },
   "mimeType": {
    "type": "string",
    "enum": [
     "image/png",
     "image/jpeg",
     "image/webp",
     "video/mp4",
     "video/webm",
     "audio/wav",
     "audio/mpeg",
     "audio/mp4"
    ]
   },
   "dataBase64": {
    "type": "string",
    "maxLength": 41943040
   }
  },
  "required": [
   "name",
   "mimeType",
   "dataBase64"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "asset.list": {
  "type": "object",
  "properties": {},
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "shot.create": {
  "type": "object",
  "properties": {
   "title": {
    "type": "string",
    "minLength": 1,
    "maxLength": 150
   },
   "prompt": {
    "type": "string",
    "maxLength": 5000
   },
   "referenceAssetIds": {
    "type": "array",
    "items": {
     "type": "string",
     "format": "uuid"
    },
    "maxItems": 8
   },
   "lastFrameAssetId": {
    "anyOf": [
     {
      "type": "string",
      "format": "uuid"
     },
     {
      "type": "null"
     }
    ],
    "description": "Optional saved last-frame image. Omission preserves the previous shape/selection; null explicitly clears it. First-frame references and reference edges are unchanged."
   },
   "aspectRatio": {
    "type": "string",
    "enum": [
     "9:16",
     "16:9",
     "1:1",
     "3:4",
     "4:3",
     "21:9"
    ]
   },
   "duration": {
    "type": "integer",
    "minimum": 1,
    "maximum": 20
   },
   "parameters": {
    "type": "object",
    "properties": {
     "scenario": {
      "type": "string",
      "enum": [
       "success",
       "failure",
       "failure_once",
       "delay",
       "timeout",
       "unknown",
       "reject",
       "download_fail_once",
       "rejected_before_accept",
       "accepted_then_response_lost",
       "poll_timeout_then_recover",
       "terminal_failure"
      ]
     },
     "delayMs": {
      "type": "integer",
      "minimum": 0,
      "maximum": 120000
     },
     "seed": {
      "type": "integer"
     }
    },
    "additionalProperties": false
   },
   "position": {
    "type": "object",
    "properties": {
     "x": {
      "type": "number"
     },
     "y": {
      "type": "number"
     }
    },
    "required": [
     "x",
     "y"
    ],
    "additionalProperties": false
   }
  },
  "required": [
   "title"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "shot.update": {
  "type": "object",
  "properties": {
   "shotId": {
    "type": "string",
    "format": "uuid"
   },
   "expectedRevision": {
    "type": "integer",
    "exclusiveMinimum": 0
   },
   "patch": {
    "type": "object",
    "properties": {
     "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 150
     },
     "prompt": {
      "type": "string",
      "maxLength": 5000
     },
     "referenceAssetIds": {
      "type": "array",
      "items": {
       "type": "string",
       "format": "uuid"
      },
      "maxItems": 8
     },
     "lastFrameAssetId": {
      "anyOf": [
       {
        "type": "string",
        "format": "uuid"
       },
       {
        "type": "null"
       }
      ],
      "description": "Optional saved last-frame image. Omission preserves the previous shape/selection; null explicitly clears it. First-frame references and reference edges are unchanged."
     },
     "aspectRatio": {
      "type": "string",
      "enum": [
       "9:16",
       "16:9",
       "1:1",
       "3:4",
       "4:3",
       "21:9"
      ]
     },
     "duration": {
      "type": "integer",
      "minimum": 1,
      "maximum": 20
     },
     "parameters": {
      "type": "object",
      "properties": {
       "scenario": {
        "type": "string",
        "enum": [
         "success",
         "failure",
         "failure_once",
         "delay",
         "timeout",
         "unknown",
         "reject",
         "download_fail_once",
         "rejected_before_accept",
         "accepted_then_response_lost",
         "poll_timeout_then_recover",
         "terminal_failure"
        ]
       },
       "delayMs": {
        "type": "integer",
        "minimum": 0,
        "maximum": 120000
       },
       "seed": {
        "type": "integer"
       }
      },
      "additionalProperties": false
     },
     "position": {
      "type": "object",
      "properties": {
       "x": {
        "type": "number"
       },
       "y": {
        "type": "number"
       }
      },
      "required": [
       "x",
       "y"
      ],
      "additionalProperties": false
     }
    },
    "additionalProperties": false
   }
  },
  "required": [
   "shotId",
   "expectedRevision",
   "patch"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "shot.reorder": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "exclusiveMinimum": 0
   },
   "shotIds": {
    "type": "array",
    "items": {
     "type": "string",
     "format": "uuid"
    }
   }
  },
  "required": [
   "expectedRevision",
   "shotIds"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "node.create": {
  "type": "object",
  "properties": {
   "type": {
    "type": "string",
    "enum": [
     "text",
     "image",
     "video",
     "audio"
    ]
   },
   "label": {
    "type": "string",
    "maxLength": 150
   },
   "text": {
    "type": "string",
    "maxLength": 5000
   },
   "assetId": {
    "type": "string",
    "format": "uuid"
   },
   "position": {
    "type": "object",
    "properties": {
     "x": {
      "type": "number"
     },
     "y": {
      "type": "number"
     }
    },
    "required": [
     "x",
     "y"
    ],
    "additionalProperties": false
   }
  },
  "required": [
   "type",
   "position"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "node.update": {
  "type": "object",
  "properties": {
   "nodeId": {
    "type": "string",
    "format": "uuid"
   },
   "expectedRevision": {
    "type": "integer",
    "exclusiveMinimum": 0
   },
   "patch": {
    "type": "object",
    "properties": {
     "label": {
      "type": "string",
      "maxLength": 150
     },
     "text": {
      "type": "string",
      "maxLength": 5000
     },
     "position": {
      "type": "object",
      "properties": {
       "x": {
        "type": "number"
       },
       "y": {
        "type": "number"
       }
      },
      "required": [
       "x",
       "y"
      ],
      "additionalProperties": false
     }
    },
    "additionalProperties": false
   }
  },
  "required": [
   "nodeId",
   "expectedRevision",
   "patch"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "edge.create": {
  "type": "object",
  "properties": {
   "source": {
    "type": "string",
    "format": "uuid"
   },
   "target": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "source",
   "target"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "edge.delete": {
  "type": "object",
  "properties": {
   "edgeId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "edgeId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "reference.attach": {
  "type": "object",
  "properties": {
   "sourceNodeId": {
    "type": "string",
    "format": "uuid"
   },
   "targetShotId": {
    "type": "string",
    "format": "uuid"
   },
   "expectedSourceRevision": {
    "type": "integer",
    "exclusiveMinimum": 0
   },
   "expectedShotRevision": {
    "type": "integer",
    "exclusiveMinimum": 0
   },
   "role": {
    "type": "string",
    "const": "first_frame"
   }
  },
  "required": [
   "sourceNodeId",
   "targetShotId",
   "expectedSourceRevision",
   "expectedShotRevision",
   "role"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "reference.detach": {
  "type": "object",
  "properties": {
   "edgeId": {
    "type": "string",
    "format": "uuid"
   },
   "expectedShotRevision": {
    "type": "integer",
    "exclusiveMinimum": 0
   }
  },
  "required": [
   "edgeId",
   "expectedShotRevision"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "provider.list": {
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "video.connection.list": {
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "generation.submit": {
  "type": "object",
  "properties": {
   "shotId": {
    "type": "string",
    "format": "uuid"
   },
   "expectedRevision": {
    "type": "integer",
    "exclusiveMinimum": 0
   },
   "providerId": {
    "type": "string",
    "enum": [
     "mock",
     "runway",
     "ark",
     "veo",
     "minimax",
     "vidu",
     "kling",
     "wan",
     "compatible"
    ]
   },
   "model": {
    "type": "string",
    "maxLength": 100
   },
   "connectionId": {
    "type": "string",
    "format": "uuid"
   },
   "configurationRevision": {
    "type": "integer",
    "exclusiveMinimum": 0
   },
   "modelEntryId": {
    "type": "string",
    "format": "uuid"
   },
   "aspectSource": {
    "anyOf": [
     {
      "type": "object",
      "properties": {
       "kind": {
        "type": "string",
        "const": "project"
       },
       "expectedTimelineRevision": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
       },
       "aspectRatio": {
        "type": "string",
        "enum": [
         "9:16",
         "16:9",
         "1:1",
         "4:3",
         "3:4",
         "21:9"
        ]
       }
      },
      "required": [
       "kind",
       "expectedTimelineRevision",
       "aspectRatio"
      ],
      "additionalProperties": false
     },
     {
      "type": "object",
      "properties": {
       "kind": {
        "type": "string",
        "const": "shot"
       }
      },
      "required": [
       "kind"
      ],
      "additionalProperties": false
     },
     {
      "type": "object",
      "properties": {
       "kind": {
        "type": "string",
        "const": "explicit"
       },
       "aspectRatio": {
        "type": "string",
        "enum": [
         "9:16",
         "16:9",
         "1:1",
         "4:3",
         "3:4",
         "21:9",
         "adaptive"
        ]
       }
      },
      "required": [
       "kind",
       "aspectRatio"
      ],
      "additionalProperties": false
     }
    ],
    "description": "Aspect source for this generation only. For a new generation, default to project: read timeline.format.get and pass its reviewed revision and ratio. Shot keeps the saved shot ratio. Explicit uses a user-selected ratio without editing the shot; adaptive requires model support. Omission preserves legacy generation behavior."
   },
   "parameters": {
    "type": "object",
    "properties": {
     "scenario": {
      "type": "string",
      "enum": [
       "success",
       "failure",
       "failure_once",
       "delay",
       "timeout",
       "unknown",
       "reject",
       "download_fail_once",
       "rejected_before_accept",
       "accepted_then_response_lost",
       "poll_timeout_then_recover",
       "terminal_failure"
      ]
     },
     "delayMs": {
      "type": "integer",
      "minimum": 0,
      "maximum": 120000
     },
     "seed": {
      "type": "integer"
     },
     "durationSeconds": {
      "anyOf": [
       {
        "type": "number",
        "const": -1
       },
       {
        "type": "integer",
        "minimum": 2,
        "maximum": 30
       }
      ]
     },
     "aspectRatio": {
      "type": "string",
      "enum": [
       "adaptive",
       "9:16",
       "16:9",
       "1:1",
       "3:4",
       "4:3",
       "21:9"
      ]
     },
     "promptExtend": {
      "type": "boolean"
     },
     "watermark": {
      "type": "boolean"
     },
     "resolution": {
      "type": "string",
      "minLength": 1,
      "maxLength": 20
     },
     "generateAudio": {
      "type": "boolean"
     }
    },
    "additionalProperties": false
   },
   "videoInput": {
    "type": "object",
    "properties": {
     "version": {
      "type": "number",
      "const": 1
     },
     "mode": {
      "type": "string",
      "enum": [
       "text",
       "first_frame",
       "first_last_frame",
       "reference_images"
      ]
     },
     "images": {
      "type": "array",
      "items": {
       "type": "object",
       "properties": {
        "role": {
         "type": "string",
         "enum": [
          "first_frame",
          "last_frame",
          "reference_image"
         ]
        },
        "assetId": {
         "type": "string",
         "format": "uuid"
        }
       },
       "required": [
        "role",
        "assetId"
       ],
       "additionalProperties": false
      },
      "maxItems": 30
     },
     "audios": {
      "type": "array",
      "items": {
       "type": "object",
       "properties": {
        "role": {
         "type": "string",
         "const": "reference_audio"
        },
        "assetId": {
         "type": "string",
         "format": "uuid"
        }
       },
       "required": [
        "role",
        "assetId"
       ],
       "additionalProperties": false
      },
      "minItems": 1,
      "maxItems": 10
     },
     "prompt": {
      "type": "string",
      "maxLength": 20000
     }
    },
    "required": [
     "version",
     "mode",
     "images"
    ],
    "additionalProperties": false,
    "description": "Versioned explicit Wan 3.0 or Seedance 2.5 input. Ordered managed image IDs replace saved shot references for this generation; omission preserves legacy selection. Wan 3.0 takes every mode, up to 10 reference images and an optional prompt; Seedance 2.5 takes only reference_images, up to 30 images and up to 10 reference audio clips (WAV or MP3, 2–30 seconds each, 30 seconds in total, audio alone allowed), and always uses the saved shot prompt."
   },
   "subjectVersionId": {
    "type": "string",
    "format": "uuid",
    "description": "Explicit immutable subject version for one subject-reference image; the server resolves its identity and metadata. Omission preserves existing frame generation. Subject and first/last-frame inputs cannot be combined."
   }
  },
  "required": [
   "shotId",
   "expectedRevision",
   "providerId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "job.get": {
  "type": "object",
  "properties": {
   "jobId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "jobId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "job.list": {
  "type": "object",
  "properties": {},
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "job.retry": {
  "type": "object",
  "properties": {
   "jobId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "jobId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "job.cancel": {
  "type": "object",
  "properties": {
   "jobId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "jobId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "job.reconcile": {
  "type": "object",
  "properties": {
   "jobId": {
    "type": "string",
    "format": "uuid"
   },
   "providerJobId": {
    "type": "string",
    "maxLength": 200
   }
  },
  "required": [
   "jobId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "version.list": {
  "type": "object",
  "properties": {
   "shotId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "shotId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "version.select": {
  "type": "object",
  "properties": {
   "shotId": {
    "type": "string",
    "format": "uuid"
   },
   "versionId": {
    "type": "string",
    "format": "uuid"
   },
   "expectedRevision": {
    "type": "integer",
    "exclusiveMinimum": 0
   }
  },
  "required": [
   "shotId",
   "versionId",
   "expectedRevision"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "export.create": {
  "type": "object",
  "properties": {},
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "export.get": {
  "type": "object",
  "properties": {
   "exportId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "exportId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.get": {
  "type": "object",
  "properties": {},
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.history.get": {
  "type": "object",
  "properties": {},
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.undo": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "exclusiveMinimum": 0
   }
  },
  "required": [
   "expectedRevision"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.redo": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "exclusiveMinimum": 0
   }
  },
  "required": [
   "expectedRevision"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.track.add": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "exclusiveMinimum": 0
   },
   "kind": {
    "type": "string",
    "enum": [
     "video",
     "audio"
    ]
   },
   "name": {
    "type": "string",
    "minLength": 1,
    "maxLength": 150
   }
  },
  "required": [
   "expectedRevision",
   "kind"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.track.update": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "exclusiveMinimum": 0
   },
   "trackId": {
    "type": "string",
    "format": "uuid"
   },
   "patch": {
    "type": "object",
    "properties": {
     "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 150
     },
     "hidden": {
      "type": "boolean"
     },
     "muted": {
      "type": "boolean"
     }
    },
    "additionalProperties": false
   }
  },
  "required": [
   "expectedRevision",
   "trackId",
   "patch"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.clip.add": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "exclusiveMinimum": 0
   },
   "assetId": {
    "type": "string",
    "format": "uuid"
   },
   "volumeEnvelope": {},
   "audioRole": {
    "anyOf": [
     {
      "type": "string",
      "enum": [
       "human",
       "music",
       "sfx"
      ]
     },
     {
      "type": "null"
     }
    ]
   },
   "colour": {
    "anyOf": [
     {
      "anyOf": [
       {
        "type": "object",
        "properties": {
         "profileId": {
          "type": "string",
          "const": "mioon-rec709-sdr-clip-v1"
         },
         "source": {
          "anyOf": [
           {
            "type": "object",
            "properties": {
             "assetSha256": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
             },
             "streamIndex": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
             },
             "profileId": {
              "type": "string",
              "const": "rec709-yuv-sdr-v1"
             },
             "range": {
              "type": "string",
              "enum": [
               "limited",
               "full"
              ]
             },
             "declaredBy": {
              "type": "string",
              "const": "user"
             },
             "declaredAt": {
              "type": "string",
              "maxLength": 40,
              "format": "date-time"
             }
            },
            "required": [
             "assetSha256",
             "streamIndex",
             "profileId",
             "range",
             "declaredBy",
             "declaredAt"
            ],
            "additionalProperties": false
           },
           {
            "type": "null"
           }
          ]
         },
         "look": {
          "anyOf": [
           {
            "type": "object",
            "properties": {
             "resourceId": {
              "type": "string",
              "format": "uuid"
             },
             "resourceSha256": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
             },
             "resourceProfile": {
              "type": "string",
              "const": "mioon-cube3d-normalized-tetrahedral-v1"
             },
             "purpose": {
              "type": "string",
              "const": "rec709-sdr-creative"
             },
             "declaredBy": {
              "type": "string",
              "const": "user"
             },
             "enabled": {
              "type": "boolean"
             },
             "strength": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
             }
            },
            "required": [
             "resourceId",
             "resourceSha256",
             "resourceProfile",
             "purpose",
             "declaredBy",
             "enabled",
             "strength"
            ],
            "additionalProperties": false
           },
           {
            "type": "null"
           }
          ]
         }
        },
        "required": [
         "profileId",
         "source",
         "look"
        ],
        "additionalProperties": false
       },
       {
        "type": "object",
        "properties": {
         "profileId": {
          "type": "string",
          "const": "mioon-srgb-image-clip-v1"
         },
         "source": {
          "anyOf": [
           {
            "type": "object",
            "properties": {
             "assetSha256": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
             },
             "profileId": {
              "type": "string",
              "const": "png-rgb8-srgb-v1"
             },
             "interpretation": {
              "type": "string",
              "const": "srgb"
             },
             "declaredBy": {
              "type": "string",
              "const": "user"
             },
             "declaredAt": {
              "type": "string",
              "maxLength": 40,
              "format": "date-time"
             },
             "evidence": {
              "type": "object",
              "properties": {
               "profileId": {
                "type": "string",
                "const": "png-rgb8-srgb-v1"
               },
               "sha256": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
               },
               "sourceByteLength": {
                "type": "integer",
                "minimum": 1,
                "maximum": 33554432
               },
               "width": {
                "type": "integer",
                "minimum": 1,
                "maximum": 4096
               },
               "height": {
                "type": "integer",
                "minimum": 1,
                "maximum": 4096
               },
               "bitDepth": {
                "type": "number",
                "const": 8
               },
               "alphaMode": {
                "type": "string",
                "enum": [
                 "opaque",
                 "straight"
                ]
               },
               "orientation": {
                "type": "number",
                "const": 1
               },
               "colourTag": {
                "type": "string",
                "enum": [
                 "srgb",
                 "untagged"
                ]
               }
              },
              "required": [
               "profileId",
               "sha256",
               "sourceByteLength",
               "width",
               "height",
               "bitDepth",
               "alphaMode",
               "orientation",
               "colourTag"
              ],
              "additionalProperties": false
             }
            },
            "required": [
             "assetSha256",
             "profileId",
             "interpretation",
             "declaredBy",
             "declaredAt",
             "evidence"
            ],
            "additionalProperties": false
           },
           {
            "type": "null"
           }
          ]
         },
         "look": {
          "anyOf": [
           {
            "type": "object",
            "properties": {
             "resourceId": {
              "type": "string",
              "format": "uuid"
             },
             "resourceSha256": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
             },
             "resourceProfile": {
              "type": "string",
              "const": "mioon-cube3d-normalized-tetrahedral-v1"
             },
             "purpose": {
              "type": "string",
              "const": "rec709-sdr-creative"
             },
             "declaredBy": {
              "type": "string",
              "const": "user"
             },
             "enabled": {
              "type": "boolean"
             },
             "strength": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
             }
            },
            "required": [
             "resourceId",
             "resourceSha256",
             "resourceProfile",
             "purpose",
             "declaredBy",
             "enabled",
             "strength"
            ],
            "additionalProperties": false
           },
           {
            "type": "null"
           }
          ]
         }
        },
        "required": [
         "profileId",
         "source",
         "look"
        ],
        "additionalProperties": false
       },
       {
        "type": "object",
        "properties": {
         "profileId": {
          "type": "string",
          "const": "mioon-jfif-image-clip-v1"
         },
         "source": {
          "anyOf": [
           {
            "type": "object",
            "properties": {
             "assetSha256": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
             },
             "profileId": {
              "type": "string",
              "const": "jfif-ycbcr8-srgb-v1"
             },
             "interpretation": {
              "type": "string",
              "const": "srgb"
             },
             "declaredBy": {
              "type": "string",
              "const": "user"
             },
             "declaredAt": {
              "type": "string",
              "maxLength": 40,
              "format": "date-time"
             },
             "evidence": {
              "type": "object",
              "properties": {
               "profileId": {
                "type": "string",
                "const": "jfif-ycbcr8-srgb-v1"
               },
               "sha256": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
               },
               "sourceByteLength": {
                "type": "integer",
                "minimum": 1,
                "maximum": 33554432
               },
               "width": {
                "type": "integer",
                "minimum": 1,
                "maximum": 4096
               },
               "height": {
                "type": "integer",
                "minimum": 1,
                "maximum": 4096
               },
               "bitDepth": {
                "type": "number",
                "const": 8
               },
               "alphaMode": {
                "type": "string",
                "const": "opaque"
               },
               "orientation": {
                "type": "number",
                "const": 1
               },
               "colourTag": {
                "type": "string",
                "const": "untagged"
               },
               "sampling": {
                "type": "string",
                "enum": [
                 "444",
                 "422",
                 "420"
                ]
               },
               "decoderPolicy": {
                "type": "string",
                "const": "ffmpeg-mjpeg-int-bt601-full-bilinear-rgb24-v1"
               }
              },
              "required": [
               "profileId",
               "sha256",
               "sourceByteLength",
               "width",
               "height",
               "bitDepth",
               "alphaMode",
               "orientation",
               "colourTag",
               "sampling",
               "decoderPolicy"
              ],
              "additionalProperties": false
             }
            },
            "required": [
             "assetSha256",
             "profileId",
             "interpretation",
             "declaredBy",
             "declaredAt",
             "evidence"
            ],
            "additionalProperties": false
           },
           {
            "type": "null"
           }
          ]
         },
         "look": {
          "anyOf": [
           {
            "type": "object",
            "properties": {
             "resourceId": {
              "type": "string",
              "format": "uuid"
             },
             "resourceSha256": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
             },
             "resourceProfile": {
              "type": "string",
              "const": "mioon-cube3d-normalized-tetrahedral-v1"
             },
             "purpose": {
              "type": "string",
              "const": "rec709-sdr-creative"
             },
             "declaredBy": {
              "type": "string",
              "const": "user"
             },
             "enabled": {
              "type": "boolean"
             },
             "strength": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
             }
            },
            "required": [
             "resourceId",
             "resourceSha256",
             "resourceProfile",
             "purpose",
             "declaredBy",
             "enabled",
             "strength"
            ],
            "additionalProperties": false
           },
           {
            "type": "null"
           }
          ]
         }
        },
        "required": [
         "profileId",
         "source",
         "look"
        ],
        "additionalProperties": false
       }
      ]
     },
     {
      "type": "null"
     }
    ]
   },
   "trackId": {
    "type": "string",
    "format": "uuid"
   },
   "name": {
    "type": "string",
    "minLength": 1,
    "maxLength": 200
   },
   "startFrame": {
    "type": "integer",
    "minimum": 0,
    "maximum": 18000
   },
   "durationFrames": {
    "type": "integer",
    "minimum": 1,
    "maximum": 18000
   },
   "sourceInFrame": {
    "type": "integer",
    "minimum": 0,
    "maximum": 9007199254722991
   },
   "rect": {
    "type": "object",
    "properties": {
     "x": {
      "type": "integer",
      "minimum": 0,
      "maximum": 2518,
      "multipleOf": 2
     },
     "y": {
      "type": "integer",
      "minimum": 0,
      "maximum": 1918,
      "multipleOf": 2
     },
     "width": {
      "type": "integer",
      "minimum": 2,
      "maximum": 2520,
      "multipleOf": 2
     },
     "height": {
      "type": "integer",
      "minimum": 2,
      "maximum": 1920,
      "multipleOf": 2
     }
    },
    "required": [
     "x",
     "y",
     "width",
     "height"
    ],
    "additionalProperties": false,
    "description": "Even pixels in the current frame basis. The rectangle must fit the current frame."
   },
   "gain": {
    "type": "number",
    "minimum": 0,
    "maximum": 2
   },
   "fadeInFrames": {
    "type": "integer",
    "minimum": 0,
    "maximum": 18000,
    "description": "Optional audio fade-in in 30fps timeline frames. Omitted means zero without storing a new key. Positive fades require confirmed source audio; fade-in plus fade-out must not exceed clip duration."
   },
   "fadeOutFrames": {
    "type": "integer",
    "minimum": 0,
    "maximum": 18000,
    "description": "Optional audio fade-out in 30fps timeline frames. Omitted means zero without storing a new key. Positive fades require confirmed source audio; fade-in plus fade-out must not exceed clip duration."
   }
  },
  "required": [
   "expectedRevision",
   "assetId",
   "trackId",
   "startFrame",
   "durationFrames"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.clip.update": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "exclusiveMinimum": 0
   },
   "clipId": {
    "type": "string",
    "format": "uuid"
   },
   "patch": {
    "type": "object",
    "properties": {
     "volumeEnvelope": {},
     "audioRole": {
      "anyOf": [
       {
        "type": "string",
        "enum": [
         "human",
         "music",
         "sfx"
        ]
       },
       {
        "type": "null"
       }
      ]
     },
     "colour": {
      "anyOf": [
       {
        "anyOf": [
         {
          "type": "object",
          "properties": {
           "profileId": {
            "type": "string",
            "const": "mioon-rec709-sdr-clip-v1"
           },
           "source": {
            "anyOf": [
             {
              "type": "object",
              "properties": {
               "assetSha256": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
               },
               "streamIndex": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
               },
               "profileId": {
                "type": "string",
                "const": "rec709-yuv-sdr-v1"
               },
               "range": {
                "type": "string",
                "enum": [
                 "limited",
                 "full"
                ]
               },
               "declaredBy": {
                "type": "string",
                "const": "user"
               },
               "declaredAt": {
                "type": "string",
                "maxLength": 40,
                "format": "date-time"
               }
              },
              "required": [
               "assetSha256",
               "streamIndex",
               "profileId",
               "range",
               "declaredBy",
               "declaredAt"
              ],
              "additionalProperties": false
             },
             {
              "type": "null"
             }
            ]
           },
           "look": {
            "anyOf": [
             {
              "type": "object",
              "properties": {
               "resourceId": {
                "type": "string",
                "format": "uuid"
               },
               "resourceSha256": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
               },
               "resourceProfile": {
                "type": "string",
                "const": "mioon-cube3d-normalized-tetrahedral-v1"
               },
               "purpose": {
                "type": "string",
                "const": "rec709-sdr-creative"
               },
               "declaredBy": {
                "type": "string",
                "const": "user"
               },
               "enabled": {
                "type": "boolean"
               },
               "strength": {
                "type": "number",
                "minimum": 0,
                "maximum": 1
               }
              },
              "required": [
               "resourceId",
               "resourceSha256",
               "resourceProfile",
               "purpose",
               "declaredBy",
               "enabled",
               "strength"
              ],
              "additionalProperties": false
             },
             {
              "type": "null"
             }
            ]
           }
          },
          "required": [
           "profileId",
           "source",
           "look"
          ],
          "additionalProperties": false
         },
         {
          "type": "object",
          "properties": {
           "profileId": {
            "type": "string",
            "const": "mioon-srgb-image-clip-v1"
           },
           "source": {
            "anyOf": [
             {
              "type": "object",
              "properties": {
               "assetSha256": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
               },
               "profileId": {
                "type": "string",
                "const": "png-rgb8-srgb-v1"
               },
               "interpretation": {
                "type": "string",
                "const": "srgb"
               },
               "declaredBy": {
                "type": "string",
                "const": "user"
               },
               "declaredAt": {
                "type": "string",
                "maxLength": 40,
                "format": "date-time"
               },
               "evidence": {
                "type": "object",
                "properties": {
                 "profileId": {
                  "type": "string",
                  "const": "png-rgb8-srgb-v1"
                 },
                 "sha256": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                 },
                 "sourceByteLength": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 33554432
                 },
                 "width": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 4096
                 },
                 "height": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 4096
                 },
                 "bitDepth": {
                  "type": "number",
                  "const": 8
                 },
                 "alphaMode": {
                  "type": "string",
                  "enum": [
                   "opaque",
                   "straight"
                  ]
                 },
                 "orientation": {
                  "type": "number",
                  "const": 1
                 },
                 "colourTag": {
                  "type": "string",
                  "enum": [
                   "srgb",
                   "untagged"
                  ]
                 }
                },
                "required": [
                 "profileId",
                 "sha256",
                 "sourceByteLength",
                 "width",
                 "height",
                 "bitDepth",
                 "alphaMode",
                 "orientation",
                 "colourTag"
                ],
                "additionalProperties": false
               }
              },
              "required": [
               "assetSha256",
               "profileId",
               "interpretation",
               "declaredBy",
               "declaredAt",
               "evidence"
              ],
              "additionalProperties": false
             },
             {
              "type": "null"
             }
            ]
           },
           "look": {
            "anyOf": [
             {
              "type": "object",
              "properties": {
               "resourceId": {
                "type": "string",
                "format": "uuid"
               },
               "resourceSha256": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
               },
               "resourceProfile": {
                "type": "string",
                "const": "mioon-cube3d-normalized-tetrahedral-v1"
               },
               "purpose": {
                "type": "string",
                "const": "rec709-sdr-creative"
               },
               "declaredBy": {
                "type": "string",
                "const": "user"
               },
               "enabled": {
                "type": "boolean"
               },
               "strength": {
                "type": "number",
                "minimum": 0,
                "maximum": 1
               }
              },
              "required": [
               "resourceId",
               "resourceSha256",
               "resourceProfile",
               "purpose",
               "declaredBy",
               "enabled",
               "strength"
              ],
              "additionalProperties": false
             },
             {
              "type": "null"
             }
            ]
           }
          },
          "required": [
           "profileId",
           "source",
           "look"
          ],
          "additionalProperties": false
         },
         {
          "type": "object",
          "properties": {
           "profileId": {
            "type": "string",
            "const": "mioon-jfif-image-clip-v1"
           },
           "source": {
            "anyOf": [
             {
              "type": "object",
              "properties": {
               "assetSha256": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
               },
               "profileId": {
                "type": "string",
                "const": "jfif-ycbcr8-srgb-v1"
               },
               "interpretation": {
                "type": "string",
                "const": "srgb"
               },
               "declaredBy": {
                "type": "string",
                "const": "user"
               },
               "declaredAt": {
                "type": "string",
                "maxLength": 40,
                "format": "date-time"
               },
               "evidence": {
                "type": "object",
                "properties": {
                 "profileId": {
                  "type": "string",
                  "const": "jfif-ycbcr8-srgb-v1"
                 },
                 "sha256": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                 },
                 "sourceByteLength": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 33554432
                 },
                 "width": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 4096
                 },
                 "height": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 4096
                 },
                 "bitDepth": {
                  "type": "number",
                  "const": 8
                 },
                 "alphaMode": {
                  "type": "string",
                  "const": "opaque"
                 },
                 "orientation": {
                  "type": "number",
                  "const": 1
                 },
                 "colourTag": {
                  "type": "string",
                  "const": "untagged"
                 },
                 "sampling": {
                  "type": "string",
                  "enum": [
                   "444",
                   "422",
                   "420"
                  ]
                 },
                 "decoderPolicy": {
                  "type": "string",
                  "const": "ffmpeg-mjpeg-int-bt601-full-bilinear-rgb24-v1"
                 }
                },
                "required": [
                 "profileId",
                 "sha256",
                 "sourceByteLength",
                 "width",
                 "height",
                 "bitDepth",
                 "alphaMode",
                 "orientation",
                 "colourTag",
                 "sampling",
                 "decoderPolicy"
                ],
                "additionalProperties": false
               }
              },
              "required": [
               "assetSha256",
               "profileId",
               "interpretation",
               "declaredBy",
               "declaredAt",
               "evidence"
              ],
              "additionalProperties": false
             },
             {
              "type": "null"
             }
            ]
           },
           "look": {
            "anyOf": [
             {
              "type": "object",
              "properties": {
               "resourceId": {
                "type": "string",
                "format": "uuid"
               },
               "resourceSha256": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
               },
               "resourceProfile": {
                "type": "string",
                "const": "mioon-cube3d-normalized-tetrahedral-v1"
               },
               "purpose": {
                "type": "string",
                "const": "rec709-sdr-creative"
               },
               "declaredBy": {
                "type": "string",
                "const": "user"
               },
               "enabled": {
                "type": "boolean"
               },
               "strength": {
                "type": "number",
                "minimum": 0,
                "maximum": 1
               }
              },
              "required": [
               "resourceId",
               "resourceSha256",
               "resourceProfile",
               "purpose",
               "declaredBy",
               "enabled",
               "strength"
              ],
              "additionalProperties": false
             },
             {
              "type": "null"
             }
            ]
           }
          },
          "required": [
           "profileId",
           "source",
           "look"
          ],
          "additionalProperties": false
         }
        ]
       },
       {
        "type": "null"
       }
      ]
     },
     "trackId": {
      "type": "string",
      "format": "uuid"
     },
     "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
     },
     "startFrame": {
      "type": "integer",
      "minimum": 0,
      "maximum": 18000
     },
     "durationFrames": {
      "type": "integer",
      "minimum": 1,
      "maximum": 18000
     },
     "sourceInFrame": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254722991
     },
     "rect": {
      "type": "object",
      "properties": {
       "x": {
        "type": "integer",
        "minimum": 0,
        "maximum": 2518,
        "multipleOf": 2
       },
       "y": {
        "type": "integer",
        "minimum": 0,
        "maximum": 1918,
        "multipleOf": 2
       },
       "width": {
        "type": "integer",
        "minimum": 2,
        "maximum": 2520,
        "multipleOf": 2
       },
       "height": {
        "type": "integer",
        "minimum": 2,
        "maximum": 1920,
        "multipleOf": 2
       }
      },
      "required": [
       "x",
       "y",
       "width",
       "height"
      ],
      "additionalProperties": false,
      "description": "Even pixels in the current frame basis. Omit for clips with a saved layout.basisPresetId; their rectangle and transform are read-only here."
     },
     "gain": {
      "type": "number",
      "minimum": 0,
      "maximum": 2
     },
     "fadeInFrames": {
      "type": "integer",
      "minimum": 0,
      "maximum": 18000,
      "description": "Optional audio fade-in in 30fps timeline frames. Omitted means zero without storing a new key. Positive fades require confirmed source audio; fade-in plus fade-out must not exceed clip duration."
     },
     "fadeOutFrames": {
      "type": "integer",
      "minimum": 0,
      "maximum": 18000,
      "description": "Optional audio fade-out in 30fps timeline frames. Omitted means zero without storing a new key. Positive fades require confirmed source audio; fade-in plus fade-out must not exceed clip duration."
     }
    },
    "additionalProperties": false
   }
  },
  "required": [
   "expectedRevision",
   "clipId",
   "patch"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.clip.replaceSource": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "exclusiveMinimum": 0
   },
   "clipId": {
    "type": "string",
    "format": "uuid"
   },
   "assetId": {
    "type": "string",
    "format": "uuid"
   },
   "versionId": {
    "type": "string",
    "format": "uuid",
    "description": "Optional exact generated version to pin with its canonical shot. Must belong to the replacement asset and project. Omission keeps an asset-only fixed reference; no version is inferred."
   }
  },
  "required": [
   "expectedRevision",
   "clipId",
   "assetId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.clip.remove": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "exclusiveMinimum": 0
   },
   "clipId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "expectedRevision",
   "clipId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.clip.rippleRemove": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "minimum": 1,
    "maximum": 9007199254740991
   },
   "clipId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "expectedRevision",
   "clipId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.clip.split": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "exclusiveMinimum": 0
   },
   "clipId": {
    "type": "string",
    "format": "uuid"
   },
   "atFrame": {
    "type": "integer",
    "minimum": 0,
    "maximum": 18000
   }
  },
  "required": [
   "expectedRevision",
   "clipId",
   "atFrame"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.seed": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "exclusiveMinimum": 0
   }
  },
  "required": [
   "expectedRevision"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "timeline.render": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "exclusiveMinimum": 0
   },
   "purpose": {
    "type": "string",
    "enum": [
     "preview",
     "export"
    ]
   },
   "exportRange": {
    "type": "object",
    "properties": {
     "startFrame": {
      "type": "integer",
      "minimum": 0,
      "maximum": 17999,
      "description": "Included start frame on the saved composition clock, fixed at 30fps."
     },
     "endFrame": {
      "type": "integer",
      "minimum": 1,
      "maximum": 18000,
      "description": "Excluded end frame on the same 30fps composition clock. Must exceed startFrame; fresh export acceptance requires it not exceed the current saved timeline duration."
     }
    },
    "required": [
     "startFrame",
     "endFrame"
    ],
    "additionalProperties": false,
    "description": "Optional export-only half-open [startFrame,endFrame) interval at the saved 30fps clock; at least one frame, bounded by the saved timeline. The full frozen snapshot remains unchanged. Omission preserves full export and historical bytes."
   },
   "deliveryName": {
    "type": "string",
    "minLength": 1,
    "maxLength": 120,
    "allOf": [
     {
      "pattern": "\\S"
     },
     {
      "pattern": "^[^\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+$(?![\\s\\S])"
     },
     {
      "pattern": "^(?:[^\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])*$"
     }
    ]
   },
   "exportSettings": {
    "anyOf": [
     {
      "type": "object",
      "properties": {
       "profileId": {
        "type": "string",
        "const": "mp4_h264_v1"
       },
       "resolution": {
        "type": "string",
        "enum": [
         "native",
         "short_360",
         "short_720",
         "short_1080"
        ]
       },
       "rateControl": {
        "anyOf": [
         {
          "type": "object",
          "properties": {
           "mode": {
            "type": "string",
            "const": "crf"
           },
           "quality": {
            "type": "string",
            "enum": [
             "compact",
             "standard",
             "high"
            ]
           }
          },
          "required": [
           "mode",
           "quality"
          ],
          "additionalProperties": false
         },
         {
          "type": "object",
          "properties": {
           "mode": {
            "type": "string",
            "const": "bitrate"
           },
           "targetKbps": {
            "type": "number",
            "enum": [
             2000,
             4000,
             8000
            ]
           }
          },
          "required": [
           "mode",
           "targetKbps"
          ],
          "additionalProperties": false
         }
        ]
       }
      },
      "required": [
       "profileId",
       "resolution",
       "rateControl"
      ],
      "additionalProperties": false
     },
     {
      "type": "object",
      "properties": {
       "profileId": {
        "type": "string",
        "const": "mp4_h264_float_checked_v2"
       },
       "resolution": {
        "type": "string",
        "enum": [
         "native",
         "short_360",
         "short_720",
         "short_1080"
        ]
       },
       "rateControl": {
        "anyOf": [
         {
          "type": "object",
          "properties": {
           "mode": {
            "type": "string",
            "const": "crf"
           },
           "quality": {
            "type": "string",
            "enum": [
             "compact",
             "standard",
             "high"
            ]
           }
          },
          "required": [
           "mode",
           "quality"
          ],
          "additionalProperties": false
         },
         {
          "type": "object",
          "properties": {
           "mode": {
            "type": "string",
            "const": "bitrate"
           },
           "targetKbps": {
            "type": "number",
            "enum": [
             2000,
             4000,
             8000
            ]
           }
          },
          "required": [
           "mode",
           "targetKbps"
          ],
          "additionalProperties": false
         }
        ]
       }
      },
      "required": [
       "profileId",
       "resolution",
       "rateControl"
      ],
      "additionalProperties": false,
      "description": "Explicit export-only float intermediate profile. The complete pre-encode sample peak must not exceed one; otherwise the export fails without publishing an asset. No automatic gain change. This is not an AAC or true-peak safety guarantee."
     }
    ]
   },
   "preflightSnapshotHash": {
    "type": "string",
    "pattern": "^[a-f0-9]{64}$",
    "description": "Optional exact snapshot digest returned by timeline.export.preflight. New renders verify it against current frozen content; exact replay still returns its original response first. Omission preserves the legacy input and response. A successful check does not guarantee future source availability or full decoding."
   }
  },
  "required": [
   "expectedRevision",
   "purpose"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "project.backup.list": {
  "type": "object",
  "properties": {},
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "project.backup.inspect": {
  "type": "object",
  "properties": {
   "backupId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "required": [
   "backupId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "project.backup.restore": {
  "type": "object",
  "properties": {
   "backupId": {
    "type": "string",
    "format": "uuid"
   },
   "projectFile": {
    "type": "string",
    "minLength": 1,
    "maxLength": 4096
   }
  },
  "required": [
   "backupId",
   "projectFile"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "project.backup.status": {
  "type": "object",
  "properties": {},
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "project.version.list": {
  "type": "object",
  "properties": {
   "limit": {
    "type": "integer",
    "minimum": 1,
    "maximum": 100
   },
   "cursor": {
    "type": "string",
    "minLength": 1,
    "maxLength": 4096
   }
  },
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "project.version.save": {
  "type": "object",
  "properties": {
   "name": {
    "type": "string",
    "minLength": 1,
    "maxLength": 150
   }
  },
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "project.version.preview": {
  "type": "object",
  "properties": {
   "versionId": {
    "type": "string",
    "format": "uuid"
   },
   "limit": {
    "type": "integer",
    "minimum": 1,
    "maximum": 100
   },
   "cursor": {
    "type": "string",
    "minLength": 1,
    "maxLength": 4096
   }
  },
  "required": [
   "versionId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "project.version.restore": {
  "type": "object",
  "properties": {
   "versionId": {
    "type": "string",
    "format": "uuid"
   },
   "expectedContentSequence": {
    "type": "integer",
    "minimum": 0,
    "maximum": 9007199254740991
   },
   "expectedContentToken": {
    "type": "string",
    "pattern": "^[a-f0-9]{32}$"
   },
   "previewDigest": {
    "type": "string",
    "pattern": "^[a-f0-9]{64}$"
   }
  },
  "required": [
   "versionId",
   "expectedContentSequence",
   "expectedContentToken",
   "previewDigest"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "asset.media.status.list": {
  "type": "object",
  "properties": {
   "cursor": {
    "type": "string",
    "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
   },
   "limit": {
    "type": "integer",
    "minimum": 1,
    "maximum": 100
   },
   "assetIds": {
    "type": "array",
    "items": {
     "type": "string",
     "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
    },
    "minItems": 1,
    "maxItems": 100
   }
  },
  "required": [],
  "additionalProperties": false
 },
 "asset.media.location.list": {
  "type": "object",
  "properties": {
   "cursor": {
    "type": "string",
    "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
   },
   "limit": {
    "type": "integer",
    "minimum": 1,
    "maximum": 100
   }
  },
  "required": [],
  "additionalProperties": false
 },
 "asset.media.prepare": {
  "type": "object",
  "properties": {
   "assets": {
    "type": "array",
    "items": {
     "type": "object",
     "properties": {
      "assetId": {
       "type": "string",
       "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
      },
      "referenceRevision": {
       "type": "integer",
       "exclusiveMinimum": 0,
       "maximum": 9007199254740991
      }
     },
     "required": [
      "assetId",
      "referenceRevision"
     ],
     "additionalProperties": false
    },
    "minItems": 1,
    "maxItems": 100
   },
   "purpose": {
    "type": "string",
    "enum": [
     "generation",
     "frame",
     "scene",
     "timeline",
     "export"
    ]
   }
  },
  "required": [
   "assets",
   "purpose"
  ],
  "additionalProperties": false
 },
 "asset.media.relink.preview": {
  "type": "object",
  "properties": {
   "assetId": {
    "type": "string",
    "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
   },
   "sourcePath": {
    "type": "string",
    "minLength": 1,
    "maxLength": 4096
   },
   "expectedReferenceRevision": {
    "type": "integer",
    "exclusiveMinimum": 0,
    "maximum": 9007199254740991
   }
  },
  "required": [
   "assetId",
   "sourcePath",
   "expectedReferenceRevision"
  ],
  "additionalProperties": false
 },
 "asset.media.relink.apply": {
  "type": "object",
  "properties": {
   "previewToken": {
    "type": "string",
    "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
   }
  },
  "required": [
   "previewToken"
  ],
  "additionalProperties": false
 },
 "asset.media.acceptChanged": {
  "type": "object",
  "properties": {
   "assetId": {
    "type": "string",
    "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
   },
   "expectedReferenceRevision": {
    "type": "integer",
    "exclusiveMinimum": 0,
    "maximum": 9007199254740991
   }
  },
  "required": [
   "assetId",
   "expectedReferenceRevision"
  ],
  "additionalProperties": false
 },
 "previs.output.publish": {
  "type": "object",
  "properties": {
   "nodeId": {
    "type": "string",
    "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
   },
   "keyframeId": {
    "type": "string",
    "pattern": "^k[1-9][0-9]{0,3}$"
   },
   "sceneRevision": {
    "type": "integer",
    "exclusiveMinimum": 0,
    "maximum": 9007199254740991
   },
   "name": {
    "type": "string",
    "minLength": 1,
    "maxLength": 200
   },
   "sha256": {
    "type": "string",
    "pattern": "^[a-f0-9]{64}$"
   },
   "width": {
    "type": "integer",
    "minimum": 1,
    "maximum": 4096
   },
   "height": {
    "type": "integer",
    "minimum": 1,
    "maximum": 4096
   },
   "dataBase64": {
    "type": "string",
    "minLength": 1,
    "maxLength": 41943040
   }
  },
  "required": [
   "nodeId",
   "keyframeId",
   "sceneRevision",
   "name",
   "sha256",
   "width",
   "height",
   "dataBase64"
  ],
  "additionalProperties": false
 },
 "previs.output.lookup": {
  "type": "object",
  "properties": {
   "nodeId": {
    "type": "string",
    "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
   },
   "keyframeId": {
    "type": "string",
    "pattern": "^k[1-9][0-9]{0,3}$"
   },
   "sceneRevision": {
    "type": "integer",
    "exclusiveMinimum": 0,
    "maximum": 9007199254740991
   },
   "name": {
    "type": "string",
    "minLength": 1,
    "maxLength": 200
   },
   "sha256": {
    "type": "string",
    "pattern": "^[a-f0-9]{64}$"
   },
   "width": {
    "type": "integer",
    "minimum": 1,
    "maximum": 4096
   },
   "height": {
    "type": "integer",
    "minimum": 1,
    "maximum": 4096
   }
  },
  "required": [
   "nodeId",
   "keyframeId",
   "sceneRevision",
   "name",
   "sha256",
   "width",
   "height"
  ],
  "additionalProperties": false
 },
 "canvas.copy.snapshot": {
  "type": "object",
  "properties": {
   "targets": {
    "type": "array",
    "items": {
     "type": "object",
     "properties": {
      "kind": {
       "type": "string",
       "enum": [
        "shot",
        "node",
        "edge"
       ]
      },
      "id": {
       "type": "string",
       "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
      }
     },
     "required": [
      "kind",
      "id"
     ],
     "additionalProperties": false
    },
    "minItems": 1,
    "maxItems": 100
   }
  },
  "required": [
   "targets"
  ],
  "additionalProperties": false
 },
 "image.service.list": {
  "type": "object",
  "properties": {},
  "required": [],
  "additionalProperties": false
 },
 "canvas.layout": {
  "type": "object",
  "properties": {
   "targets": {
    "type": "array",
    "items": {
     "type": "object",
     "properties": {
      "kind": {
       "type": "string",
       "enum": [
        "shot",
        "node"
       ]
      },
      "id": {
       "type": "string",
       "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
      }
     },
     "required": [
      "kind",
      "id"
     ],
     "additionalProperties": false
    },
    "minItems": 1,
    "maxItems": 100
   }
  },
  "additionalProperties": false
 },
 "canvas.archive": {
  "type": "object",
  "properties": {
   "targets": {
    "type": "array",
    "items": {
     "type": "object",
     "properties": {
      "kind": {
       "type": "string",
       "enum": [
        "shot",
        "node",
        "edge"
       ]
      },
      "id": {
       "type": "string",
       "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
      }
     },
     "required": [
      "kind",
      "id"
     ],
     "additionalProperties": false
    },
    "minItems": 1,
    "maxItems": 100
   }
  },
  "required": [
   "targets"
  ],
  "additionalProperties": false
 },
 "canvas.restore": {
  "type": "object",
  "properties": {
   "targets": {
    "type": "array",
    "items": {
     "type": "object",
     "properties": {
      "kind": {
       "type": "string",
       "enum": [
        "shot",
        "node",
        "edge"
       ]
      },
      "id": {
       "type": "string",
       "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
      }
     },
     "required": [
      "kind",
      "id"
     ],
     "additionalProperties": false
    },
    "minItems": 1,
    "maxItems": 100
   }
  },
  "required": [
   "targets"
  ],
  "additionalProperties": false
 },
 "sequence.tool.edit": {
  "type": "object",
  "anyOf": [
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "connect"
     },
     "fromId": {
      "type": "string",
      "format": "uuid"
     },
     "toId": {
      "type": "string",
      "format": "uuid"
     }
    },
    "required": [
     "kind",
     "fromId",
     "toId"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "disconnect"
     },
     "fromId": {
      "type": "string",
      "format": "uuid"
     },
     "toId": {
      "type": "string",
      "format": "uuid"
     }
    },
    "required": [
     "kind",
     "fromId",
     "toId"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "insert"
     },
     "fromId": {
      "type": "string",
      "format": "uuid"
     },
     "toId": {
      "type": "string",
      "format": "uuid"
     },
     "nodeId": {
      "type": "string",
      "format": "uuid"
     }
    },
    "required": [
     "kind",
     "fromId",
     "toId",
     "nodeId"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "delete-node"
     },
     "nodeId": {
      "type": "string",
      "format": "uuid"
     }
    },
    "required": [
     "kind",
     "nodeId"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "reorder"
     },
     "clipId": {
      "type": "string",
      "format": "uuid"
     },
     "beforeClipId": {
      "anyOf": [
       {
        "type": "string",
        "format": "uuid"
       },
       {
        "type": "null"
       }
      ]
     }
    },
    "required": [
     "kind",
     "clipId",
     "beforeClipId"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "remove"
     },
     "clipId": {
      "type": "string",
      "format": "uuid"
     }
    },
    "required": [
     "kind",
     "clipId"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "split"
     },
     "clipId": {
      "type": "string",
      "format": "uuid"
     },
     "offsetFrames": {
      "type": "integer",
      "minimum": 1,
      "maximum": 18000
     }
    },
    "required": [
     "kind",
     "clipId",
     "offsetFrames"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "set-mode"
     },
     "clipId": {
      "type": "string",
      "format": "uuid"
     },
     "mode": {
      "type": "string",
      "enum": [
       "follow",
       "locked"
      ]
     },
     "versionId": {
      "anyOf": [
       {
        "type": "string",
        "format": "uuid"
       },
       {
        "type": "null"
       }
      ]
     }
    },
    "required": [
     "kind",
     "clipId",
     "mode"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "copy-move"
     },
     "clipId": {
      "type": "string",
      "format": "uuid"
     },
     "beforeClipId": {
      "anyOf": [
       {
        "type": "string",
        "format": "uuid"
       },
       {
        "type": "null"
       }
      ]
     }
    },
    "required": [
     "kind",
     "clipId",
     "beforeClipId"
    ],
    "additionalProperties": false
   }
  ]
 },
 "sequence.tool.board": {
  "anyOf": [
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "board-root-create"
     },
     "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
     },
     "position": {
      "type": "object",
      "properties": {
       "x": {
        "type": "number",
        "minimum": -1000000,
        "maximum": 1000000
       },
       "y": {
        "type": "number",
        "minimum": -1000000,
        "maximum": 1000000
       }
      },
      "required": [
       "x",
       "y"
      ],
      "additionalProperties": false
     }
    },
    "required": [
     "kind",
     "name",
     "position"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "board-shot-append"
     },
     "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
     },
     "position": {
      "type": "object",
      "properties": {
       "x": {
        "type": "number",
        "minimum": -1000000,
        "maximum": 1000000
       },
       "y": {
        "type": "number",
        "minimum": -1000000,
        "maximum": 1000000
       }
      },
      "required": [
       "x",
       "y"
      ],
      "additionalProperties": false
     }
    },
    "required": [
     "kind",
     "name"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "board-layout-move"
     },
     "moves": {
      "type": "array",
      "items": {
       "type": "object",
       "properties": {
        "nodeId": {
         "type": "string",
         "format": "uuid"
        },
        "x": {
         "type": "number",
         "minimum": -1000000,
         "maximum": 1000000
        },
        "y": {
         "type": "number",
         "minimum": -1000000,
         "maximum": 1000000
        }
       },
       "required": [
        "nodeId",
        "x",
        "y"
       ],
       "additionalProperties": false
      },
      "minItems": 1,
      "maxItems": 50
     }
    },
    "required": [
     "kind",
     "moves"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "board-node-create"
     },
     "type": {
      "type": "string",
      "enum": [
       "image",
       "video",
       "audio",
       "text"
      ]
     },
     "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 150
     },
     "position": {
      "type": "object",
      "properties": {
       "x": {
        "type": "number",
        "minimum": -1000000,
        "maximum": 1000000
       },
       "y": {
        "type": "number",
        "minimum": -1000000,
        "maximum": 1000000
       }
      },
      "required": [
       "x",
       "y"
      ],
      "additionalProperties": false
     },
     "assetId": {
      "type": "string",
      "format": "uuid"
     },
     "text": {
      "type": "string",
      "maxLength": 5000
     }
    },
    "required": [
     "kind",
     "type",
     "name",
     "position"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "board-shot-update"
     },
     "shotId": {
      "type": "string",
      "format": "uuid"
     },
     "expectedRevision": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
     },
     "patch": {
      "type": "object",
      "properties": {
       "title": {
        "type": "string",
        "minLength": 1,
        "maxLength": 500
       },
       "prompt": {
        "type": "string",
        "maxLength": 20000
       },
       "duration": {
        "type": "number",
        "minimum": 0.05,
        "maximum": 600
       },
       "aspectRatio": {
        "type": "string",
        "enum": [
         "9:16",
         "16:9"
        ]
       },
       "position": {
        "type": "object",
        "properties": {
         "x": {
          "type": "number",
          "minimum": -1000000,
          "maximum": 1000000
         },
         "y": {
          "type": "number",
          "minimum": -1000000,
          "maximum": 1000000
         }
        },
        "required": [
         "x",
         "y"
        ],
        "additionalProperties": false
       }
      },
      "additionalProperties": false
     }
    },
    "required": [
     "kind",
     "shotId",
     "expectedRevision",
     "patch"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "board-node-update"
     },
     "nodeId": {
      "type": "string",
      "format": "uuid"
     },
     "expectedRevision": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
     },
     "patch": {
      "type": "object",
      "properties": {
       "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 150
       },
       "text": {
        "type": "string",
        "maxLength": 5000
       },
       "position": {
        "type": "object",
        "properties": {
         "x": {
          "type": "number",
          "minimum": -1000000,
          "maximum": 1000000
         },
         "y": {
          "type": "number",
          "minimum": -1000000,
          "maximum": 1000000
         }
        },
        "required": [
         "x",
         "y"
        ],
        "additionalProperties": false
       }
      },
      "additionalProperties": false
     }
    },
    "required": [
     "kind",
     "nodeId",
     "expectedRevision",
     "patch"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "board-restore"
     },
     "targets": {
      "type": "array",
      "items": {
       "type": "object",
       "properties": {
        "kind": {
         "type": "string",
         "enum": [
          "shot",
          "node"
         ]
        },
        "id": {
         "type": "string",
         "format": "uuid"
        }
       },
       "required": [
        "kind",
        "id"
       ],
       "additionalProperties": false
      },
      "minItems": 1,
      "maxItems": 50
     }
    },
    "required": [
     "kind",
     "targets"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "board-duplicate"
     },
     "targets": {
      "type": "array",
      "items": {
       "type": "object",
       "properties": {
        "kind": {
         "type": "string",
         "enum": [
          "shot",
          "node"
         ]
        },
        "id": {
         "type": "string",
         "format": "uuid"
        }
       },
       "required": [
        "kind",
        "id"
       ],
       "additionalProperties": false
      },
      "minItems": 1,
      "maxItems": 50
     },
     "viewport": {
      "type": "object",
      "properties": {
       "x": {
        "type": "number"
       },
       "y": {
        "type": "number"
       },
       "width": {
        "type": "number",
        "exclusiveMinimum": 0
       },
       "height": {
        "type": "number",
        "exclusiveMinimum": 0
       }
      },
      "required": [
       "x",
       "y",
       "width",
       "height"
      ],
      "additionalProperties": false
     }
    },
    "required": [
     "kind",
     "targets"
    ],
    "additionalProperties": false
   }
  ]
 },
 "sequence.tool.reference": {
  "anyOf": [
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "reference-attach"
     },
     "sourceNodeId": {
      "type": "string",
      "format": "uuid"
     },
     "shotId": {
      "type": "string",
      "format": "uuid"
     },
     "role": {
      "type": "string",
      "enum": [
       "first_frame",
       "last_frame",
       "reference_image",
       "composition",
       "reference_audio",
       "reference_video",
       "subject_reference",
       "style_reference"
      ]
     }
    },
    "required": [
     "kind",
     "sourceNodeId",
     "shotId"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "reference-set-role"
     },
     "edgeId": {
      "type": "string",
      "format": "uuid"
     },
     "shotId": {
      "type": "string",
      "format": "uuid"
     },
     "role": {
      "type": "string",
      "enum": [
       "first_frame",
       "last_frame",
       "reference_image",
       "composition",
       "reference_audio",
       "reference_video",
       "subject_reference",
       "style_reference"
      ]
     }
    },
    "required": [
     "kind",
     "edgeId",
     "shotId",
     "role"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "reference-detach"
     },
     "edgeId": {
      "type": "string",
      "format": "uuid"
     },
     "shotId": {
      "type": "string",
      "format": "uuid"
     }
    },
    "required": [
     "kind",
     "edgeId",
     "shotId"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "reference-reorder"
     },
     "shotId": {
      "type": "string",
      "format": "uuid"
     },
     "edgeIds": {
      "type": "array",
      "items": {
       "type": "string",
       "format": "uuid"
      },
      "minItems": 1,
      "maxItems": 48
     }
    },
    "required": [
     "kind",
     "shotId",
     "edgeIds"
    ],
    "additionalProperties": false
   }
  ]
 },
 "sequence.tool.subject": {
  "anyOf": [
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "subject-binding"
     },
     "edit": {
      "anyOf": [
       {
        "type": "object",
        "properties": {
         "kind": {
          "type": "string",
          "const": "create"
         },
         "shotId": {
          "type": "string",
          "format": "uuid"
         },
         "subjectId": {
          "type": "string",
          "format": "uuid"
         },
         "role": {
          "type": "string",
          "enum": [
           "subject",
           "style"
          ]
         }
        },
        "required": [
         "kind",
         "shotId",
         "subjectId",
         "role"
        ],
        "additionalProperties": false
       },
       {
        "type": "object",
        "properties": {
         "kind": {
          "type": "string",
          "const": "set-mode"
         },
         "bindingId": {
          "type": "string",
          "format": "uuid"
         },
         "bindingMode": {
          "type": "string",
          "enum": [
           "follow",
           "locked"
          ]
         },
         "subjectVersionId": {
          "anyOf": [
           {
            "type": "string",
            "format": "uuid"
           },
           {
            "type": "null"
           }
          ]
         }
        },
        "required": [
         "kind",
         "bindingId",
         "bindingMode",
         "subjectVersionId"
        ],
        "additionalProperties": false
       },
       {
        "type": "object",
        "properties": {
         "kind": {
          "type": "string",
          "const": "detach"
         },
         "bindingId": {
          "type": "string",
          "format": "uuid"
         }
        },
        "required": [
         "kind",
         "bindingId"
        ],
        "additionalProperties": false
       },
       {
        "type": "object",
        "properties": {
         "kind": {
          "type": "string",
          "const": "restore"
         },
         "bindingId": {
          "type": "string",
          "format": "uuid"
         },
         "bindingMode": {
          "type": "string",
          "enum": [
           "follow",
           "locked"
          ]
         },
         "subjectVersionId": {
          "anyOf": [
           {
            "type": "string",
            "format": "uuid"
           },
           {
            "type": "null"
           }
          ]
         }
        },
        "required": [
         "kind",
         "bindingId",
         "bindingMode",
         "subjectVersionId"
        ],
        "additionalProperties": false
       }
      ]
     }
    },
    "required": [
     "kind",
     "edit"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "subject-card-create"
     },
     "subjectId": {
      "type": "string",
      "format": "uuid"
     },
     "position": {
      "type": "object",
      "properties": {
       "x": {
        "type": "number",
        "minimum": -1000000,
        "maximum": 1000000
       },
       "y": {
        "type": "number",
        "minimum": -1000000,
        "maximum": 1000000
       }
      },
      "required": [
       "x",
       "y"
      ],
      "additionalProperties": false
     }
    },
    "required": [
     "kind",
     "subjectId"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "subject-card-delete"
     },
     "nodeId": {
      "type": "string",
      "format": "uuid"
     }
    },
    "required": [
     "kind",
     "nodeId"
    ],
    "additionalProperties": false
   }
  ]
 },
 "sequence.tool.previs": {
  "anyOf": [
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "previs-create"
     },
     "label": {
      "type": "string",
      "maxLength": 150
     },
     "position": {
      "type": "object",
      "properties": {
       "x": {
        "type": "number",
        "minimum": -1000000,
        "maximum": 1000000
       },
       "y": {
        "type": "number",
        "minimum": -1000000,
        "maximum": 1000000
       }
      },
      "required": [
       "x",
       "y"
      ],
      "additionalProperties": false
     }
    },
    "required": [
     "kind",
     "label"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "previs-scene-set"
     },
     "nodeId": {
      "type": "string",
      "format": "uuid"
     },
     "expectedSceneRevision": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
     },
     "scene": {
      "type": "object",
      "properties": {
       "schemaVersion": {
        "type": "number",
        "const": 1
       },
       "figures": {
        "type": "array",
        "items": {
         "type": "object",
         "properties": {
          "id": {
           "type": "string",
           "pattern": "^f[1-9][0-9]{0,3}$"
          },
          "name": {
           "type": "string",
           "maxLength": 20,
           "pattern": "^[^\\u0000-\\u001f\\u007f-\\u009f\\ud800-\\udfff]*$"
          },
          "visible": {
           "type": "boolean"
          },
          "position": {
           "type": "array",
           "minItems": 3,
           "maxItems": 3,
           "items": [
            {
             "type": "number",
             "minimum": -100,
             "maximum": 100
            },
            {
             "type": "number",
             "minimum": -100,
             "maximum": 100
            },
            {
             "type": "number",
             "minimum": -100,
             "maximum": 100
            }
           ]
          },
          "rotation": {
           "type": "number",
           "minimum": -180,
           "maximum": 180
          },
          "pose": {
           "type": "string",
           "enum": [
            "stand",
            "walk",
            "sit",
            "hold",
            "look-back"
           ]
          },
          "held": {
           "anyOf": [
            {
             "type": "object",
             "properties": {
              "propId": {
               "type": "string",
               "pattern": "^p[1-9][0-9]{0,3}$"
              },
              "hand": {
               "type": "string",
               "enum": [
                "left",
                "right"
               ]
              }
             },
             "required": [
              "propId",
              "hand"
             ],
             "additionalProperties": false
            },
            {
             "type": "null"
            }
           ]
          },
          "subject": {
           "type": "object",
           "properties": {
            "subjectId": {
             "type": "string",
             "format": "uuid"
            },
            "subjectVersionId": {
             "type": "string",
             "format": "uuid"
            }
           },
           "required": [
            "subjectId"
           ],
           "additionalProperties": false
          }
         },
         "required": [
          "id",
          "name",
          "visible",
          "position",
          "rotation",
          "pose",
          "held"
         ],
         "additionalProperties": false
        },
        "maxItems": 8
       },
       "props": {
        "type": "array",
        "items": {
         "type": "object",
         "properties": {
          "id": {
           "type": "string",
           "pattern": "^p[1-9][0-9]{0,3}$"
          },
          "kind": {
           "type": "string",
           "enum": [
            "box",
            "cylinder",
            "sphere",
            "panel",
            "umbrella",
            "phone",
            "bag",
            "cup"
           ]
          },
          "name": {
           "type": "string",
           "maxLength": 20,
           "pattern": "^[^\\u0000-\\u001f\\u007f-\\u009f\\ud800-\\udfff]*$"
          },
          "visible": {
           "type": "boolean"
          },
          "position": {
           "type": "array",
           "minItems": 3,
           "maxItems": 3,
           "items": [
            {
             "type": "number",
             "minimum": -100,
             "maximum": 100
            },
            {
             "type": "number",
             "minimum": -100,
             "maximum": 100
            },
            {
             "type": "number",
             "minimum": -100,
             "maximum": 100
            }
           ]
          },
          "rotation": {
           "type": "number",
           "minimum": -180,
           "maximum": 180
          },
          "size": {
           "type": "array",
           "minItems": 3,
           "maxItems": 3,
           "items": [
            {
             "type": "number",
             "minimum": 0.01,
             "maximum": 20
            },
            {
             "type": "number",
             "minimum": 0.01,
             "maximum": 20
            },
            {
             "type": "number",
             "minimum": 0.01,
             "maximum": 20
            }
           ]
          },
          "subject": {
           "type": "object",
           "properties": {
            "subjectId": {
             "type": "string",
             "format": "uuid"
            },
            "subjectVersionId": {
             "type": "string",
             "format": "uuid"
            }
           },
           "required": [
            "subjectId"
           ],
           "additionalProperties": false
          }
         },
         "required": [
          "id",
          "kind",
          "name",
          "visible",
          "position",
          "rotation",
          "size"
         ],
         "additionalProperties": false
        },
        "maxItems": 24
       },
       "light": {
        "type": "object",
        "properties": {
         "visible": {
          "type": "boolean"
         },
         "azimuth": {
          "type": "number",
          "minimum": -180,
          "maximum": 180
         },
         "elevation": {
          "type": "number",
          "minimum": -90,
          "maximum": 90
         },
         "intensity": {
          "type": "number",
          "minimum": 0,
          "maximum": 4
         }
        },
        "required": [
         "visible",
         "azimuth",
         "elevation",
         "intensity"
        ],
        "additionalProperties": false
       },
       "camera": {
        "type": "object",
        "properties": {
         "position": {
          "type": "array",
          "minItems": 3,
          "maxItems": 3,
          "items": [
           {
            "type": "number",
            "minimum": -100,
            "maximum": 100
           },
           {
            "type": "number",
            "minimum": -100,
            "maximum": 100
           },
           {
            "type": "number",
            "minimum": -100,
            "maximum": 100
           }
          ]
         },
         "yaw": {
          "type": "number",
          "minimum": -180,
          "maximum": 180
         },
         "pitch": {
          "type": "number",
          "minimum": -90,
          "maximum": 90
         },
         "focalLength": {
          "type": "number",
          "minimum": 10,
          "maximum": 300
         }
        },
        "required": [
         "position",
         "yaw",
         "pitch",
         "focalLength"
        ],
        "additionalProperties": false
       },
       "keyframes": {
        "type": "array",
        "items": {
         "type": "object",
         "properties": {
          "id": {
           "type": "string",
           "pattern": "^k[1-9][0-9]{0,3}$"
          },
          "name": {
           "type": "string",
           "maxLength": 20,
           "pattern": "^[^\\u0000-\\u001f\\u007f-\\u009f\\ud800-\\udfff]*$"
          },
          "camera": {
           "type": "object",
           "properties": {
            "position": {
             "type": "array",
             "minItems": 3,
             "maxItems": 3,
             "items": [
              {
               "type": "number",
               "minimum": -100,
               "maximum": 100
              },
              {
               "type": "number",
               "minimum": -100,
               "maximum": 100
              },
              {
               "type": "number",
               "minimum": -100,
               "maximum": 100
              }
             ]
            },
            "yaw": {
             "type": "number",
             "minimum": -180,
             "maximum": 180
            },
            "pitch": {
             "type": "number",
             "minimum": -90,
             "maximum": 90
            },
            "focalLength": {
             "type": "number",
             "minimum": 10,
             "maximum": 300
            }
           },
           "required": [
            "position",
            "yaw",
            "pitch",
            "focalLength"
           ],
           "additionalProperties": false
          },
          "exports": {
           "type": "array",
           "items": {
            "type": "string",
            "format": "uuid"
           },
           "maxItems": 4
          }
         },
         "required": [
          "id",
          "name",
          "camera",
          "exports"
         ],
         "additionalProperties": false
        },
        "maxItems": 24
       },
       "activeKeyframeId": {
        "anyOf": [
         {
          "type": "string",
          "pattern": "^k[1-9][0-9]{0,3}$"
         },
         {
          "type": "null"
         }
        ]
       }
      },
      "required": [
       "schemaVersion",
       "figures",
       "props",
       "light",
       "camera",
       "keyframes",
       "activeKeyframeId"
      ],
      "additionalProperties": false
     }
    },
    "required": [
     "kind",
     "nodeId",
     "expectedSceneRevision",
     "scene"
    ],
    "additionalProperties": false
   }
  ]
 },
 "sequence.tool.timeline": {
  "anyOf": [
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "dialogue"
     },
     "shotId": {
      "type": "string",
      "format": "uuid"
     },
     "edits": {
      "type": "array",
      "items": {
       "anyOf": [
        {
         "type": "object",
         "properties": {
          "kind": {
           "type": "string",
           "const": "add"
          },
          "text": {
           "type": "string",
           "minLength": 1,
           "maxLength": 81
          },
          "speakerSubjectId": {
           "anyOf": [
            {
             "type": "string",
             "format": "uuid"
            },
            {
             "type": "null"
            }
           ]
          },
          "beforeLineId": {
           "type": "string",
           "format": "uuid"
          }
         },
         "required": [
          "kind",
          "text"
         ],
         "additionalProperties": false
        },
        {
         "type": "object",
         "properties": {
          "kind": {
           "type": "string",
           "const": "update"
          },
          "lineId": {
           "type": "string",
           "format": "uuid"
          },
          "text": {
           "type": "string",
           "minLength": 1,
           "maxLength": 81
          },
          "speakerSubjectId": {
           "anyOf": [
            {
             "type": "string",
             "format": "uuid"
            },
            {
             "type": "null"
            }
           ]
          }
         },
         "required": [
          "kind",
          "lineId"
         ],
         "additionalProperties": false
        },
        {
         "type": "object",
         "properties": {
          "kind": {
           "type": "string",
           "const": "remove"
          },
          "lineId": {
           "type": "string",
           "format": "uuid"
          }
         },
         "required": [
          "kind",
          "lineId"
         ],
         "additionalProperties": false
        },
        {
         "type": "object",
         "properties": {
          "kind": {
           "type": "string",
           "const": "reorder"
          },
          "lineIds": {
           "type": "array",
           "items": {
            "type": "string",
            "format": "uuid"
           },
           "minItems": 1,
           "maxItems": 100
          }
         },
         "required": [
          "kind",
          "lineIds"
         ],
         "additionalProperties": false
        }
       ]
      },
      "minItems": 1,
      "maxItems": 30
     }
    },
    "required": [
     "kind",
     "shotId",
     "edits"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "subtitles"
     },
     "edits": {
      "type": "array",
      "items": {
       "anyOf": [
        {
         "type": "object",
         "properties": {
          "kind": {
           "type": "string",
           "const": "add"
          },
          "cue": {
           "type": "object",
           "properties": {
            "text": {
             "type": "string",
             "maxLength": 256
            },
            "startFrame": {
             "type": "integer",
             "minimum": 0,
             "maximum": 300000
            },
            "durationFrames": {
             "type": "integer",
             "minimum": 1,
             "maximum": 300000
            },
            "anchor": {},
            "dialogueRef": {}
           },
           "required": [
            "text",
            "startFrame",
            "durationFrames"
           ],
           "additionalProperties": false
          }
         },
         "required": [
          "kind",
          "cue"
         ],
         "additionalProperties": false
        },
        {
         "type": "object",
         "properties": {
          "kind": {
           "type": "string",
           "const": "update"
          },
          "cueId": {
           "type": "string",
           "format": "uuid"
          },
          "patch": {
           "type": "object",
           "additionalProperties": {}
          }
         },
         "required": [
          "kind",
          "cueId",
          "patch"
         ],
         "additionalProperties": false
        },
        {
         "type": "object",
         "properties": {
          "kind": {
           "type": "string",
           "const": "remove"
          },
          "cueId": {
           "type": "string",
           "format": "uuid"
          }
         },
         "required": [
          "kind",
          "cueId"
         ],
         "additionalProperties": false
        }
       ]
      },
      "minItems": 1,
      "maxItems": 100
     }
    },
    "required": [
     "kind",
     "edits"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "format-set"
     },
     "presetId": {
      "type": "string",
      "enum": [
       "portrait_1080",
       "landscape_1080",
       "square_1080",
       "portrait_720",
       "landscape_720",
       "square_720"
      ]
     }
    },
    "required": [
     "kind",
     "presetId"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "split-at-scenes"
     },
     "assetId": {
      "type": "string",
      "format": "uuid"
     },
     "resultId": {
      "type": "string",
      "format": "uuid"
     }
    },
    "required": [
     "kind",
     "assetId",
     "resultId"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "separate-sound"
     },
     "clipId": {
      "type": "string",
      "format": "uuid"
     }
    },
    "required": [
     "kind",
     "clipId"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "generate"
     },
     "placement": {
      "anyOf": [
       {
        "type": "object",
        "properties": {
         "kind": {
          "type": "string",
          "const": "main"
         },
         "beforeClipId": {
          "anyOf": [
           {
            "type": "string",
            "format": "uuid"
           },
           {
            "type": "null"
           }
          ]
         }
        },
        "required": [
         "kind",
         "beforeClipId"
        ],
        "additionalProperties": false
       },
       {
        "type": "object",
        "properties": {
         "kind": {
          "type": "string",
          "const": "track"
         },
         "trackId": {
          "type": "string",
          "format": "uuid"
         },
         "startFrame": {
          "type": "integer",
          "minimum": 0,
          "maximum": 300000
         }
        },
        "required": [
         "kind",
         "trackId",
         "startFrame"
        ],
        "additionalProperties": false
       }
      ]
     },
     "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
     },
     "providerId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
     },
     "model": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
     },
     "region": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
     },
     "prompt": {
      "type": "string",
      "maxLength": 5000
     },
     "aspectRatio": {
      "type": "string",
      "minLength": 1,
      "maxLength": 40
     },
     "duration": {
      "type": "integer",
      "minimum": 1,
      "maximum": 60
     },
     "parameters": {
      "type": "object",
      "additionalProperties": {}
     },
     "connectionId": {
      "type": "string",
      "format": "uuid"
     },
     "configurationRevision": {
      "type": "integer",
      "minimum": 1
     },
     "modelEntryId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
     }
    },
    "required": [
     "kind",
     "placement",
     "providerId",
     "model",
     "region",
     "prompt",
     "aspectRatio",
     "duration"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "insert-asset"
     },
     "assetId": {
      "type": "string",
      "format": "uuid"
     },
     "trackId": {
      "anyOf": [
       {
        "type": "string",
        "format": "uuid"
       },
       {
        "type": "null"
       }
      ]
     },
     "startFrame": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
     }
    },
    "required": [
     "kind",
     "assetId",
     "trackId",
     "startFrame"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "track-add"
     },
     "trackKind": {
      "type": "string",
      "enum": [
       "video",
       "audio"
      ]
     },
     "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 150
     }
    },
    "required": [
     "kind",
     "trackKind"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "track-update"
     },
     "trackId": {
      "type": "string",
      "format": "uuid"
     },
     "patch": {
      "type": "object",
      "properties": {
       "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 150
       },
       "hidden": {
        "type": "boolean"
       },
       "muted": {
        "type": "boolean"
       },
       "orderIndex": {
        "type": "integer",
        "minimum": 0,
        "maximum": 11
       }
      },
      "additionalProperties": false
     }
    },
    "required": [
     "kind",
     "trackId",
     "patch"
    ],
    "additionalProperties": false
   }
  ]
 },
 "sequence.tool.clip": {
  "anyOf": [
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "clip-properties"
     },
     "edits": {
      "type": "array",
      "items": {
       "type": "object",
       "properties": {
        "clipId": {
         "type": "string",
         "pattern": "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
        },
        "patch": {
         "type": "object",
         "properties": {
          "transform": {},
          "transition": {},
          "gain": {
           "type": "number",
           "minimum": 0,
           "maximum": 2
          },
          "fadeInFrames": {
           "type": "integer",
           "minimum": 0,
           "maximum": 300000
          },
          "fadeOutFrames": {
           "type": "integer",
           "minimum": 0,
           "maximum": 300000
          },
          "colour": {},
          "audioRole": {},
          "volumeEnvelope": {},
          "name": {
           "type": "string",
           "minLength": 1,
           "maxLength": 200
          },
          "muted": {
           "type": "boolean"
          }
         },
         "additionalProperties": false
        }
       },
       "required": [
        "clipId",
        "patch"
       ],
       "additionalProperties": false
      },
      "minItems": 1,
      "maxItems": 100
     }
    },
    "required": [
     "kind",
     "edits"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "replace-source"
     },
     "clipId": {
      "type": "string",
      "format": "uuid"
     },
     "assetId": {
      "type": "string",
      "format": "uuid"
     },
     "versionId": {
      "type": "string",
      "format": "uuid"
     }
    },
    "required": [
     "kind",
     "clipId",
     "assetId"
    ],
    "additionalProperties": false
   },
   {
    "type": "object",
    "properties": {
     "kind": {
      "type": "string",
      "const": "copy-as-new-shot"
     },
     "clipId": {
      "type": "string",
      "format": "uuid"
     }
    },
    "required": [
     "kind",
     "clipId"
    ],
    "additionalProperties": false
   }
  ]
 },
 "sequence.tool.undo": {
  "type": "object",
  "properties": {
   "actionId": {
    "type": "string",
    "format": "uuid"
   }
  },
  "additionalProperties": false
 },
 "canvas.paste": {
  "type": "object",
  "properties": {
   "snapshotId": {
    "type": "string",
    "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
   },
   "viewport": {
    "type": "object",
    "properties": {
     "x": {
      "type": "number",
      "minimum": -10000000,
      "maximum": 10000000
     },
     "y": {
      "type": "number",
      "minimum": -10000000,
      "maximum": 10000000
     },
     "width": {
      "type": "number",
      "exclusiveMinimum": 0,
      "maximum": 20000000
     },
     "height": {
      "type": "number",
      "exclusiveMinimum": 0,
      "maximum": 20000000
     }
    },
    "required": [
     "x",
     "y",
     "width",
     "height"
    ],
    "additionalProperties": false
   }
  },
  "required": [
   "snapshotId",
   "viewport"
  ],
  "additionalProperties": false
 },
 "canvas.duplicate": {
  "type": "object",
  "properties": {
   "targets": {
    "type": "array",
    "items": {
     "type": "object",
     "properties": {
      "kind": {
       "type": "string",
       "enum": [
        "shot",
        "node",
        "edge"
       ]
      },
      "id": {
       "type": "string",
       "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
      }
     },
     "required": [
      "kind",
      "id"
     ],
     "additionalProperties": false
    },
    "minItems": 1,
    "maxItems": 100
   },
   "viewport": {
    "type": "object",
    "properties": {
     "x": {
      "type": "number",
      "minimum": -10000000,
      "maximum": 10000000
     },
     "y": {
      "type": "number",
      "minimum": -10000000,
      "maximum": 10000000
     },
     "width": {
      "type": "number",
      "exclusiveMinimum": 0,
      "maximum": 20000000
     },
     "height": {
      "type": "number",
      "exclusiveMinimum": 0,
      "maximum": 20000000
     }
    },
    "required": [
     "x",
     "y",
     "width",
     "height"
    ],
    "additionalProperties": false
   }
  },
  "required": [
   "targets",
   "viewport"
  ],
  "additionalProperties": false
 }
};
export const AGENT_TASK_THUMBNAIL_READ_PARAMETERS:unknown={
 "type": "object",
 "properties": {
  "nodeId": {
   "type": "string",
   "format": "uuid"
  },
  "slots": {
   "type": "array",
   "items": {
    "type": "string",
    "pattern": "^(?:card|k[1-9][0-9]{0,3})$"
   },
   "minItems": 1,
   "maxItems": 1
  }
 },
 "required": [
  "nodeId",
  "slots"
 ],
 "additionalProperties": false,
 "$schema": "http://json-schema.org/draft-07/schema#"
};
export const AGENT_TASK_FORMAT4_THUMBNAIL_SCHEMAS:Readonly<Record<string,unknown>>={
 "previs.thumbnail.get": {
  "type": "object",
  "properties": {
   "nodeId": {
    "type": "string",
    "format": "uuid"
   },
   "slots": {
    "type": "array",
    "items": {
     "type": "string",
     "pattern": "^(?:card|k[1-9][0-9]{0,3})$"
    },
    "minItems": 1,
    "maxItems": 1
   },
   "framePresetId": {
    "type": "string",
    "enum": [
     "portrait_1080",
     "landscape_1080",
     "square_1080",
     "portrait_720",
     "landscape_720",
     "square_720",
     "landscape_4_3_1080",
     "portrait_3_4_1080",
     "ultrawide_1080",
     "landscape_4_3_720",
     "portrait_3_4_720",
     "ultrawide_720"
    ]
   }
  },
  "required": [
   "nodeId",
   "slots",
   "framePresetId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "previs.thumbnail.set": {
  "type": "object",
  "properties": {
   "nodeId": {
    "type": "string",
    "format": "uuid"
   },
   "slot": {
    "type": "string",
    "pattern": "^(?:card|k[1-9][0-9]{0,3})$"
   },
   "sceneRevision": {
    "type": "integer",
    "minimum": 1,
    "maximum": 9007199254740991
   },
   "dataBase64": {
    "type": "string",
    "minLength": 4,
    "maxLength": 87384,
    "pattern": "^[A-Za-z0-9+/]+={0,2}$"
   },
   "framePresetId": {
    "type": "string",
    "enum": [
     "portrait_1080",
     "landscape_1080",
     "square_1080",
     "portrait_720",
     "landscape_720",
     "square_720",
     "landscape_4_3_1080",
     "portrait_3_4_1080",
     "ultrawide_1080",
     "landscape_4_3_720",
     "portrait_3_4_720",
     "ultrawide_720"
    ]
   }
  },
  "required": [
   "nodeId",
   "slot",
   "sceneRevision",
   "dataBase64",
   "framePresetId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 }
};
