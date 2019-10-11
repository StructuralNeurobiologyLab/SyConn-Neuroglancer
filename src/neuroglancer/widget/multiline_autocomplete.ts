/**
 * @license
 * Copyright 2016 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import './multiline_autocomplete.css';

import debounce from 'lodash/debounce';
import {CancellationToken, CancellationTokenSource} from 'neuroglancer/util/cancellation';
import {BasicCompletionResult, Completion, CompletionWithDescription} from 'neuroglancer/util/completion';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeChildren, removeFromParent} from 'neuroglancer/util/dom';
import {positionDropdown} from 'neuroglancer/util/dropdown';
import {EventActionMap, KeyboardEventBinder, registerActionListener} from 'neuroglancer/util/keyboard_bindings';
import {longestCommonPrefix} from 'neuroglancer/util/longest_common_prefix';
import {scrollIntoViewIfNeeded} from 'neuroglancer/util/scroll_into_view';
import {Signal} from 'neuroglancer/util/signal';
import ResizeObserver from 'resize-observer-polyfill';

export {Completion, CompletionWithDescription} from 'neuroglancer/util/completion';

const ACTIVE_COMPLETION_CLASS_NAME = 'neuroglancer-multiline-autocomplete-completion-active';

const AUTOCOMPLETE_INDEX_SYMBOL = Symbol('autocompleteIndex');

export interface CompletionResult extends BasicCompletionResult {
  showSingleResult?: boolean;
  selectSingleResult?: boolean;
  makeElement?: (completion: Completion) => HTMLElement;
}

export function makeDefaultCompletionElement(completion: Completion) {
  let element = document.createElement('div');
  element.textContent = completion.value;
  return element;
}

function cleanZeroWidthSpaces(s: string) {
  return s.replace(/\u200b/g, '');
}

function* splitByWordBreaks(value: string) {
  while (value.length > 0) {
    const m = value.match(/[:/_]+/);
    if (m === null) {
      yield value;
      return;
    }
    const endOffset = m.index! + m[0].length;
    yield value.substring(0, endOffset);
    value = value.substring(endOffset);
  }
}

export function makeCompletionElementWithDescription(completion: CompletionWithDescription) {
  let element = document.createElement('div');
  element.className = 'neuroglancer-multiline-autocomplete-completion-with-description';
  element.textContent = completion.value;
  let descriptionElement = document.createElement('div');
  descriptionElement.className = 'neuroglancer-multiline-autocomplete-completion-description';
  descriptionElement.textContent = completion.description || '';
  element.appendChild(descriptionElement);
  return element;
}

const keyMap = EventActionMap.fromObject({
  'arrowdown': {action: 'cycle-next-active-completion'},
  'arrowup': {action: 'cycle-prev-active-completion'},
  'tab': {action: 'choose-active-completion-or-prefix', preventDefault: false},
  'enter': {action: 'commit'},
  'escape': {action: 'cancel', preventDefault: false, stopPropagation: false},
});

export type Completer = (value: string, cancellationToken: CancellationToken) =>
    Promise<CompletionResult>| null;

const DEFAULT_COMPLETION_DELAY = 200;  // milliseconds

export class AutocompleteTextInput extends RefCounted {
  element = document.createElement('div');
  inputElement = document.createElement('span');
  hintElement = document.createElement('span');
  dropdownElement = document.createElement('div');
  inputChanged = new Signal<(value: string) => void>();
  private prevInputValue: string|undefined = '';
  private completionsVisible = false;
  private activeCompletionPromise: Promise<CompletionResult>|null = null;
  private activeCompletionCancellationToken: CancellationTokenSource|undefined = undefined;
  private hasFocus = false;
  private completionResult: CompletionResult|null = null;
  private dropdownContentsStale = true;
  private completionElements: HTMLElement[]|null = null;
  private hasResultForDropdown = false;
  private commonPrefix = '';

  private getSelectionRange() {
    const s = window.getSelection();
    if (s === null) return undefined;
    if (s.rangeCount === 0) return undefined;
    const startRange = s.getRangeAt(0);
    const {inputElement} = this;
    const {firstChild} = inputElement;
    const beforeRange = document.createRange();
    if (firstChild === null) return undefined;
    beforeRange.setStart(firstChild, 0);
    beforeRange.setEnd(startRange.endContainer, startRange.endOffset);
    const begin = cleanZeroWidthSpaces(beforeRange.toString()).length;
    const length = cleanZeroWidthSpaces(s.toString()).length;
    return {begin, end: begin + length};
  }

  private setInputText(
      value: string, selection: {begin: number, end: number}|undefined = undefined) {
    const {inputElement} = this;
    removeChildren(inputElement);
    // Ensure the input element doesn't collapse completely.
    let outputOffset = 0;
    if (value === '') {
      outputOffset = 1;
      value = '\u200b';  // zero-width space
    }
    const r = selection !== undefined ? document.createRange() : undefined;
    let isFirst = true;
    for (const text of splitByWordBreaks(value)) {
      if (!isFirst) {
        inputElement.appendChild(document.createElement('wbr'));
      }
      isFirst = false;
      const newOutputOffset = outputOffset + text.length;
      const node = document.createTextNode(text);
      inputElement.appendChild(node);
      if (r !== undefined) {
        const {begin, end} = selection!;
        if (begin >= outputOffset && begin <= newOutputOffset) {
          r.setStart(node, begin - outputOffset);
        }
        if (end >= outputOffset && end <= newOutputOffset) {
          r.setEnd(node, end - outputOffset);
        }
      }
      outputOffset = newOutputOffset;
    };
    if (r !== undefined) {
      const s = window.getSelection();
      if (s !== null) {
        s.removeAllRanges();
        s.addRange(r);
      }
    }
  }

  /**
   * Index of the active completion.  The active completion is displayed as the hint text and is
   * highlighted in the dropdown.
   */
  private activeIndex = -1;

  private dropdownStyleStale = true;

  private scheduleUpdateCompletions: () => void;
  completer: Completer;

  private resizeHandler = () => {
    if (!this.completionsVisible) return;
    this.updateDropdownStyle();
  };

  private resizeObserver = new ResizeObserver(this.resizeHandler);

  constructor(options: {completer: Completer, delay?: number}) {
    super();
    this.completer = options.completer;
    const {delay = DEFAULT_COMPLETION_DELAY} = options;

    let debouncedCompleter = this.scheduleUpdateCompletions = debounce(() => {
      const cancellationToken = this.activeCompletionCancellationToken =
          new CancellationTokenSource();
      let activeCompletionPromise = this.activeCompletionPromise =
          this.completer(this.value, cancellationToken);
      if (activeCompletionPromise !== null) {
        activeCompletionPromise.then(completionResult => {
          if (this.activeCompletionPromise === activeCompletionPromise) {
            this.setCompletions(completionResult);
            this.activeCompletionPromise = null;
          }
        });
      }
    }, delay);
    this.registerDisposer(() => {
      debouncedCompleter.cancel();
    });

    const {element, inputElement, hintElement, dropdownElement} = this;
    element.classList.add('neuroglancer-multiline-autocomplete');
    this.registerEventListener(window, 'resize', this.resizeHandler);

    this.resizeObserver.observe(element);
    this.registerDisposer(() => this.resizeObserver.unobserve(inputElement));

    inputElement.contentEditable = 'true';
    inputElement.spellcheck = false;
    this.setInputText('');
    dropdownElement.classList.add('neuroglancer-multiline-autocomplete-dropdown');
    dropdownElement.style.display = 'none';
    element.appendChild(inputElement);
    element.appendChild(hintElement);
    element.appendChild(dropdownElement);
    inputElement.classList.add('neuroglancer-multiline-autocomplete-input');
    hintElement.classList.add('neuroglancer-multiline-autocomplete-hint');
    inputElement.addEventListener('input', () => {
      this.setInputText(this.value, this.getSelectionRange());
      this.updateHintState();
    });
    this.registerEventListener(document, 'selectionchange', () => {
      this.updateHintState();
    });
    this.updateHintState();

    element.addEventListener('pointerdown', (event: PointerEvent) => {
      const {target} = event;
      if (target instanceof Node && inputElement.contains(target)) return;
      if (inputElement === document.activeElement) {
        this.moveCaretToEndOfInput();
        event.stopPropagation();
        event.preventDefault();
      }
    });
      
    element.addEventListener('click', () => {
      inputElement.focus();
    });

    this.registerEventListener(this.inputElement, 'focus', () => {
      if (!this.hasFocus) {
        this.hasFocus = true;
        this.dropdownStyleStale = true;
        this.updateDropdown();
        const r = document.createRange();
        const {childNodes} = inputElement;
        r.setStartBefore(childNodes[0]);
        r.setEndAfter(childNodes[childNodes.length - 1]);
        const s = window.getSelection();
        if (s !== null) {
          s.removeAllRanges();
          s.addRange(r);
        }
      }
    });
    this.registerEventListener(this.inputElement, 'blur', () => {
      if (this.hasFocus) {
        this.hasFocus = false;
        this.updateDropdown();
      }
      this.updateHintState();
      this.inputChanged.dispatch(this.value);
    });
    this.registerEventListener(element.ownerDocument!.defaultView!, 'resize', () => {
      this.dropdownStyleStale = true;
    });

    this.registerEventListener(element.ownerDocument!.defaultView!, 'scroll', () => {
      this.dropdownStyleStale = true;
    });

    this.registerEventListener(
        this.dropdownElement, 'mousedown', this.handleDropdownMousedown.bind(this));

    const keyboardHandler = this.registerDisposer(new KeyboardEventBinder(inputElement, keyMap));
    keyboardHandler.allShortcutsAreGlobal = true;

    registerActionListener(inputElement, 'cycle-next-active-completion', () => {
      this.cycleActiveCompletion(+1);
    });

    registerActionListener(inputElement, 'cycle-prev-active-completion', () => {
      this.cycleActiveCompletion(-1);
    });

    registerActionListener(
        inputElement, 'choose-active-completion-or-prefix', (event: CustomEvent) => {
          if (this.selectActiveCompletion(/*allowPrefix=*/true)) {
            event.preventDefault();
          }
        });
    registerActionListener(inputElement, 'commit', (event: CustomEvent) => {
      if (this.selectActiveCompletion(/*allowPrefix=*/false)) {
        event.stopPropagation();
      } else {
        this.inputChanged.dispatch(this.value);
      }
    });
    registerActionListener(inputElement, 'cancel', (event: CustomEvent) => {
      event.stopPropagation();
      if (this.cancel()) {
        event.detail.preventDefault();
        event.detail.stopPropagation();
      }
    });
  }

  private shouldAttemptCompletion() {
    const {inputElement} = this;
    if (document.activeElement !== inputElement) return false;
    const s = window.getSelection();
    if (s === null) return false;
    if (!s.isCollapsed) return false;
    if (s.focusNode === inputElement && s.focusOffset === inputElement.childNodes.length) {
      return true;
    }
    const lastChild = inputElement.lastChild;
    if (lastChild === null) {
      // Should not happen
      return false;
    }
    if (s.focusNode !== lastChild || s.focusOffset !== (lastChild.textContent || '').length) {
      return false;
    }
    return true;
  }

  private updateHintState() {
    if (!this.shouldAttemptCompletion()) {
      this.cancelActiveCompletion();
      this.clearCompletions();
      this.hintElement.textContent = '';
      return;
    } else {
      const {value} = this;
      if (value === this.prevInputValue) {
        // Completion already in progress.
        return;
      }
      this.cancelActiveCompletion();
      this.hintElement.textContent = '';
      this.clearCompletions();
      this.prevInputValue = value;
      this.scheduleUpdateCompletions();
    }
  }

  private handleDropdownMousedown(event: MouseEvent) {
    this.inputElement.focus();
    let {dropdownElement} = this;
    for (let target: EventTarget|null = event.target; target instanceof HTMLElement;
         target = target.parentElement) {
      let index = (<any>target)[AUTOCOMPLETE_INDEX_SYMBOL];
      if (index !== undefined) {
        this.selectCompletion(index);
        break;
      }
      if (target === dropdownElement) {
        break;
      }
    }
    event.preventDefault();
  }

  cycleActiveCompletion(delta: number) {
    if (this.completionResult === null) {
      return;
    }
    let {activeIndex} = this;
    let numCompletions = this.completionResult.completions.length;
    if (activeIndex === -1) {
      if (delta > 0) {
        activeIndex = 0;
      } else {
        activeIndex = numCompletions - 1;
      }
    } else {
      activeIndex = (activeIndex + delta + numCompletions) % numCompletions;
    }
    this.setActiveIndex(activeIndex);
  }

  private shouldShowDropdown() {
    let {completionResult} = this;
    if (completionResult === null || !this.hasFocus) {
      return false;
    }
    return this.hasResultForDropdown;
  }

  private updateDropdownStyle() {
    const {dropdownElement, element} = this;
    positionDropdown(dropdownElement, element, {horizontal: false});
    this.dropdownStyleStale = false;
  }

  private updateDropdown() {
    if (this.shouldShowDropdown()) {
      let {dropdownElement} = this;
      let {activeIndex} = this;
      if (this.dropdownContentsStale) {
        let completionResult = this.completionResult!;
        let {makeElement = makeDefaultCompletionElement} = completionResult;
        this.completionElements = completionResult.completions.map((completion, index) => {
          let completionElement = makeElement.call(completionResult, completion);
          (<any>completionElement)[AUTOCOMPLETE_INDEX_SYMBOL] = index;
          completionElement.classList.add('neuroglancer-multiline-autocomplete-completion');
          if (activeIndex === index) {
            completionElement.classList.add(ACTIVE_COMPLETION_CLASS_NAME);
          }
          dropdownElement.appendChild(completionElement);
          return completionElement;
        });
        this.dropdownContentsStale = false;
      }
      if (this.dropdownStyleStale) {
        this.updateDropdownStyle();
      }
      if (!this.completionsVisible) {
        dropdownElement.style.display = '';
        this.completionsVisible = true;
      }
      if (activeIndex !== -1) {
        let completionElement = this.completionElements![activeIndex];
        scrollIntoViewIfNeeded(completionElement);
      }
    } else if (this.completionsVisible) {
      this.dropdownElement.style.display = 'none';
      this.completionsVisible = false;
    }
  }

  private setCompletions(completionResult: CompletionResult) {
    this.clearCompletions();
    let {completions} = completionResult;
    if (completions.length === 0) {
      return;
    }
    const value = this.prevInputValue;
    if (value === undefined) return;
    this.completionResult = completionResult;

    if (completions.length === 1) {
      let completion = completions[0];
      if (completionResult.showSingleResult) {
        this.hasResultForDropdown = true;
      } else {
        if (!completion.value.startsWith(value)) {
          this.hasResultForDropdown = true;
        } else {
          this.hasResultForDropdown = false;
        }
      }
      if (completionResult.selectSingleResult) {
        this.setActiveIndex(0);
      } else {
        this.setHintValue(this.getCompletedValueByIndex(0));
      }
    } else {
      this.hasResultForDropdown = true;
      // Check for a common prefix.
      let commonResultPrefix = longestCommonPrefix(function*() {
        for (let completion of completionResult.completions) {
          yield completion.value;
        }
      }());
      let commonPrefix = this.getCompletedValue(commonResultPrefix);
      if (commonPrefix.startsWith(value)) {
        this.commonPrefix = commonPrefix;
        this.setHintValue(commonPrefix);
      }
    }
    this.updateDropdown();
  }

  setHintValue(hintValue: string) {
    const value = this.prevInputValue;
    if (value === undefined) return;
    if (hintValue === value || !hintValue.startsWith(value)) {
      // If the hint value is identical to the current value, there is no need to show it.  Also,
      // if it is not a prefix of the current value, then we cannot show it either.
      hintValue = '';
    }
    hintValue = hintValue.substring(value.length);
    const {hintElement} = this;
    removeChildren(hintElement);
    let isFirst = true;
    for (const text of splitByWordBreaks(hintValue)) {
      if (!isFirst) {
        hintElement.appendChild(document.createElement('wbr'));
      }
      isFirst = false;
      const node = document.createTextNode(text);
      hintElement.appendChild(node);
    }    
  }

  /**
   * This sets the active completion, which causes it to be highlighted and displayed as the hint.
   * Additionally, if the user hits tab then it is chosen.
   */
  private setActiveIndex(index: number) {
    if (!this.dropdownContentsStale) {
      let {activeIndex} = this;
      if (activeIndex !== -1) {
        this.completionElements![activeIndex].classList.remove(ACTIVE_COMPLETION_CLASS_NAME);
      }
      if (index !== -1) {
        let completionElement = this.completionElements![index];
        completionElement.classList.add(ACTIVE_COMPLETION_CLASS_NAME);
        scrollIntoViewIfNeeded(completionElement);
      }
    }
    if (index !== -1) {
      this.setHintValue(this.getCompletedValueByIndex(index));
    }
    this.activeIndex = index;
  }

  private getCompletedValueByIndex(index: number) {
    return this.getCompletedValue(this.completionResult!.completions[index].value);
  }

  private getCompletedValue(completionValue: string) {
    let completionResult = this.completionResult!;
    let value = this.prevInputValue;
    if (value === undefined) return '';
    return value.substring(0, completionResult.offset) + completionValue;
  }

  private moveCaretToEndOfInput() {
    const r = document.createRange();
    const {childNodes} = this.inputElement;
    const lastNode = childNodes[childNodes.length - 1];
    r.setStartAfter(lastNode);
    r.setEndAfter(lastNode);
    const s = window.getSelection();
    if (s !== null) {
      s.removeAllRanges();
      s.addRange(r);
      this.updateHintState();
    }
  }

  selectActiveCompletion(allowPrefix: boolean) {
    let {activeIndex} = this;
    if (activeIndex === -1) {
      if (!allowPrefix) {
        return false;
      }
      let {completionResult} = this;
      if (completionResult !== null && completionResult.completions.length === 1) {
        activeIndex = 0;
      } else {
        let {commonPrefix} = this;
        if (commonPrefix.length > this.value.length) {
          this.value = commonPrefix;
          this.moveCaretToEndOfInput();
          return true;
        }
        return false;
      }
    }
    let newValue = this.getCompletedValueByIndex(activeIndex);
    if (this.value === newValue) {
      return false;
    }
    this.value = newValue;
    this.moveCaretToEndOfInput();
    return true;
  }

  selectCompletion(index: number) {
    this.value = this.getCompletedValueByIndex(index);
    this.moveCaretToEndOfInput();
  }

  /**
   * Called when user presses escape.  Does nothing here, but may be overridden in a subclass.
   */
  cancel() {
    return false;
  }

  private cancelActiveCompletion() {
    this.prevInputValue = undefined;
    const token = this.activeCompletionCancellationToken;
    if (token !== undefined) {
      token.cancel();
    }
    this.activeCompletionCancellationToken = undefined;
    this.activeCompletionPromise = null;
  }

  private clearCompletions() {
    if (this.completionResult !== null) {
      this.activeIndex = -1;
      this.completionResult = null;
      this.completionElements = null;
      this.dropdownContentsStale = true;
      this.dropdownStyleStale = true;
      this.commonPrefix = '';
      removeChildren(this.dropdownElement);
      this.updateDropdown();
    }
  }

  get value() {
    return cleanZeroWidthSpaces(this.inputElement.textContent || '');
  }

  set value(value: string) {
    if (value !== this.value) {
      this.setInputText(value);
      this.updateHintState();
    }
  }

  disposed() {
    removeFromParent(this.element);
    this.cancelActiveCompletion();
    super.disposed();
  }
}
