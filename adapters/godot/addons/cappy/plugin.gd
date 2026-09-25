@tool
extends EditorPlugin

## Registers the Cappy autoload when the plugin is enabled.

const AUTOLOAD_NAME := "Cappy"


func _enable_plugin() -> void:
	add_autoload_singleton(AUTOLOAD_NAME, "res://addons/cappy/cappy_adapter.gd")


func _disable_plugin() -> void:
	remove_autoload_singleton(AUTOLOAD_NAME)
