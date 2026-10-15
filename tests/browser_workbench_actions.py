"""UI-only adapter for the editor's always-present Actions menu."""
def workbench_action(page, test_id):
    action = page.get_by_test_id(test_id)
    if not action.is_visible():
        page.get_by_test_id('workbench-actions').click()
    return action
