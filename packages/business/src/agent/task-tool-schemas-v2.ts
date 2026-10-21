// Generated with node scripts/generate-agent-task-schemas.ts.
// Shared runtime schemas remain authoritative; host supplies project identity and replay keys.
export const AGENT_TASK_TOOL_SCHEMA_HASH="fe173487c007ebd40537a704fb9a6865af03d917264f89c67e4e541fc2150f64";
export const AGENT_TASK_TOOL_SCHEMAS:Readonly<Record<string,unknown>>={
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
   },
   "automaticBackup": {
    "type": "boolean"
   },
   "backupIntervalHours": {
    "type": "number",
    "enum": [
     1,
     6,
     24,
     168
    ]
   },
   "backupLocation": {
    "type": "string",
    "enum": [
     "default",
     "selected"
    ]
   }
  },
  "required": [
   "expectedRevision"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "workspace.backup.status": {
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "workspace.backup.list": {
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "workspace.backup.create": {
  "type": "object",
  "properties": {},
  "required": [],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "workspace.backup.restore.stage": {
  "type": "object",
  "properties": {
   "backupId": {
    "type": "string",
    "format": "uuid"
   },
   "confirmation": {
    "type": "string",
    "const": "RESTORE_BACKUP"
   }
  },
  "required": [
   "backupId",
   "confirmation"
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
 "project.delete": {
  "type": "object",
  "properties": {
   "expectedRevision": {
    "type": "integer",
    "exclusiveMinimum": 0,
    "maximum": 9007199254740991
   },
   "confirmPermanentDeletion": {
    "type": "boolean",
    "const": true
   }
  },
  "required": [
   "expectedRevision",
   "confirmPermanentDeletion"
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
 "workspace.backup.inspect": {
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "description": "Reads bounded workspace database counts for an offline backup. No path input, file copying, task recovery, credentials or provider calls. The running backend must be closed before cold capture.",
  "$schema": "http://json-schema.org/draft-07/schema#"
 },
 "workspace.restore.inspect": {
  "type": "object",
  "properties": {
   "includeAudioRoleCapability": {
    "type": "boolean",
    "const": true
   },
   "includeVolumeEnvelopeCapability": {
    "type": "boolean",
    "const": true
   }
  },
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
     "wan"
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
   "parameters": {
    "type": "object",
    "properties": {
     "scenario": {
      "type": "string",
      "enum": [
       "success",
       "failure",
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
      "maximum": 1918,
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
      "maximum": 1920,
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
    "additionalProperties": false
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
        "maximum": 1918,
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
        "maximum": 1920,
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
      "additionalProperties": false
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
 }
};
