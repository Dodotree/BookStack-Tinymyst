{{--
@pageId
@extensions
--}}
<div component="ajax-form"
     option:ajax-form:url="/attachments/new-file"
     option:ajax-form:method="post"
     option:ajax-form:response-container="#new-file-form-container"
     option:ajax-form:success-message="{{ trans('entities.attachments_new_file_created') }}">
    <input type="hidden" name="attachment_new_uploaded_to" value="{{ $pageId }}">
    <p class="text-muted small">{{ trans('entities.attachments_explain_new_file') }}</p>

    <div class="form-group">
        <label for="attachment_new_name">{{ trans('entities.attachments_new_file_name') }}</label>
        <input name="attachment_new_name" id="attachment_new_name" type="text" placeholder="{{ trans('entities.attachments_new_file_name_hint') }}" value="{{ $attachment_new_name ?? '' }}">
        @if($errors->has('attachment_new_name'))
            <div class="text-neg text-small">{{ $errors->first('attachment_new_name') }}</div>
        @endif
    </div>

    <div class="form-group">
        <label for="attachment_new_extension">{{ trans('entities.attachments_new_file_extension') }}</label>
        <select name="attachment_new_extension" id="attachment_new_extension">
            @foreach($extensions as $extension)
                <option value="{{ $extension }}" @if(($attachment_new_extension ?? '') === $extension) selected @endif>.{{ $extension }}</option>
            @endforeach
        </select>
        @if($errors->has('attachment_new_extension'))
            <div class="text-neg text-small">{{ $errors->first('attachment_new_extension') }}</div>
        @endif
    </div>

    <button component="event-emit-select"
            option:event-emit-select:name="edit-back"
            type="button"
            class="button outline">{{ trans('common.cancel') }}</button>
    <button refs="ajax-form@submit"
            data-tinymist-new-file-submit="true"
            type="button"
            class="button">{{ trans('entities.attachments_new_file_create') }}</button>
</div>
