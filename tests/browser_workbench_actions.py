"""UI-only entry adapters; opening a menu/popover never submits work."""
def workbench_action(page, test_id):
    if test_id == 'jobs-button':
        all_tasks = page.get_by_test_id('task-overview-all')
        if not all_tasks.is_visible():
            page.get_by_test_id('jobs-button').click()
        return all_tasks
    action = page.get_by_test_id(test_id)
    if action.is_visible():
        return action
    if test_id in {'export-button', 'timeline-format-open'}:
        page.get_by_test_id('project-switcher').click()
    elif test_id in {'add-video-track', 'add-audio-track', 'seed-timeline', 'timeline-render-preview'}:
        page.get_by_role('button', name='轨道', exact=True).click()
    elif test_id in {'export-timeline', 'export-history'}:
        export_button = page.get_by_test_id('export-timeline')
        if not export_button.is_visible():
            page.get_by_test_id('workspace-editing').click()
        if test_id == 'export-history':
            export_button.click()
    else:
        page.get_by_test_id('workbench-actions').click()
    return action


def close_task_center(page):
    dialog = page.get_by_test_id('task-center-dialog')
    if dialog.is_visible():
        dialog.get_by_role('button', name='关闭', exact=True).click()


def select_asset_kind(page, name):
    page.get_by_test_id('asset-filters-open').click()
    page.get_by_role('tab', name=name, exact=True).click()
    page.keyboard.press('Escape')
