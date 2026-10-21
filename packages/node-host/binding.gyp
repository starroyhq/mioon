{
  "targets": [{
    "target_name": "mioon_private_storage",
    "sources": ["native/private-storage.cc"],
    "defines": ["NAPI_VERSION=8", "WIN32_LEAN_AND_MEAN", "NOMINMAX", "_WIN32_WINNT=0x0A00"],
    "conditions": [["OS=='win'", {
      "libraries": ["advapi32.lib", "bcrypt.lib"],
      "msvs_settings": {"VCCLCompilerTool": {"ExceptionHandling": 1, "WarningLevel": 4, "AdditionalOptions": ["/std:c++20"]}}
    }]]
  }]
}
